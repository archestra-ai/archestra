/**
 * subscriptions/listen through the real gateway route, over a real socket.
 *
 * `inject` cannot exercise a hijacked never-ending response, so these listen on
 * an ephemeral port and read the SSE stream with fetch — which is also exactly
 * how a client consumes it.
 */

import type { AddressInfo } from "node:net";
import { context, propagation, type Span, trace } from "@opentelemetry/api";
import { node, tracing } from "@opentelemetry/sdk-node";
import { addChildSpanToSpan } from "@sentry/core";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import config from "@/config";
import { rememberErrorTrackingServerSpan } from "@/observability/request-context";
import { ATTR_MCP_METHOD_NAME } from "@/observability/tracing";
import { isLongLivedMcpStream } from "@/observability/utils";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import mcpGatewayRoutes from "./index";

describe("MCP Gateway - subscriptions/listen route", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(mcpGatewayRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function setup({
    makeAgent,
    makeOrganization,
    makeServiceAccountToken,
  }: {
    makeAgent: (args?: Record<string, unknown>) => Promise<{ id: string }>;
    makeOrganization: () => Promise<{ id: string }>;
    makeServiceAccountToken: (args: {
      organizationId: string;
    }) => Promise<{ value: string }>;
  }) {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const token = await makeServiceAccountToken({ organizationId: org.id });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    return { agent, token, url: `http://127.0.0.1:${port}/v1/mcp/${agent.id}` };
  }

  test("opens an SSE stream whose first event is the acknowledgment", async ({
    makeAgent,
    makeOrganization,
    makeServiceAccountToken,
  }) => {
    const { token, url } = await setup({
      makeAgent,
      makeOrganization,
      makeServiceAccountToken,
    });

    const controller = new AbortController();
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.value}`,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "subscriptions/listen",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "subscriptions/listen",
        params: {
          notifications: { toolsListChanged: true, promptsListChanged: true },
        },
        id: 42,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    // Read until the first SSE event frame arrives.
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no response body");
    let buffer = "";
    while (!buffer.includes("\n\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += new TextDecoder().decode(value);
    }
    controller.abort();

    const ack = JSON.parse(buffer.split("data: ")[1].split("\n")[0]);
    expect(ack).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: {
        _meta: { "io.modelcontextprotocol/subscriptionId": 42 },
        // toolsListChanged honored; promptsListChanged omitted because the
        // gateway cannot serve it — the client learns this up front.
        notifications: { toolsListChanged: true },
      },
    });
    expect(ack.params.notifications).not.toHaveProperty("promptsListChanged");
  });

  test("an enabled duration cap ends the authenticated stream with its matching result", async ({
    makeAgent,
    makeOrganization,
    makeServiceAccountToken,
  }) => {
    config.mcpGateway.subscriptionMaxDurationMs = 50;
    const { token, url } = await setup({
      makeAgent,
      makeOrganization,
      makeServiceAccountToken,
    });
    const response = await fetch(url, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.value}`,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "subscriptions/listen",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "subscriptions/listen",
        params: { notifications: { toolsListChanged: true } },
        id: 43,
      }),
    });

    expect(response.status).toBe(200);
    const frames = (await response.text())
      .split("\n\n")
      .filter((frame) => frame.includes("data: "))
      .map((frame) => JSON.parse(frame.split("data: ")[1]));
    expect(frames[0]).toMatchObject({
      method: "notifications/subscriptions/acknowledged",
      params: { _meta: { "io.modelcontextprotocol/subscriptionId": 43 } },
    });
    expect(frames.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 43,
      result: {
        resultType: "complete",
        _meta: { "io.modelcontextprotocol/subscriptionId": 43 },
      },
    });
  });

  test("a legacy client gets method-not-found, not a stream", async ({
    makeAgent,
    makeOrganization,
    makeServiceAccountToken,
  }) => {
    const { token, url } = await setup({
      makeAgent,
      makeOrganization,
      makeServiceAccountToken,
    });

    // No revision declaration and no stateless markers: the method does not
    // exist in the legacy revision, so the SDK answers -32601.
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.value}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "subscriptions/listen",
        params: { notifications: { toolsListChanged: true } },
        id: 1,
      }),
    });

    const body = await response.json();
    expect(body.error).toMatchObject({ code: -32601 });
  });

  test("a listen request without an id is rejected", async ({
    makeAgent,
    makeOrganization,
    makeServiceAccountToken,
  }) => {
    const { token, url } = await setup({
      makeAgent,
      makeOrganization,
      makeServiceAccountToken,
    });

    // The subscription id IS the JSON-RPC id; a notification-shaped listen
    // has nothing for later messages to correlate against.
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.value}`,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "subscriptions/listen",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "subscriptions/listen",
        params: { notifications: { toolsListChanged: true } },
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.message).toContain("id");
  });

  test("server/discover advertises tools.listChanged only for 2026-07-28", async ({
    makeAgent,
    makeOrganization,
    makeServiceAccountToken,
  }) => {
    const { token, url } = await setup({
      makeAgent,
      makeOrganization,
      makeServiceAccountToken,
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token.value}`,
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "server/discover",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "server/discover",
        id: 2,
      }),
    });

    const body = await response.json();
    // Now backed by subscriptions/listen — for the revision that has it. A
    // legacy client still sees false, since it has no notification channel.
    expect(body.result.capabilities.tools.listChanged).toBe(true);
  });

  test("records the method on the request spans, so traces can leave the stream out of request latency", async ({
    makeAgent,
    makeOrganization,
    makeServiceAccountToken,
  }) => {
    // Open spans the way a request gets them with error tracking on: an
    // OpenTelemetry server span whose children record it as their root, and a
    // server span of error tracking's own in a separate trace.
    const exporter = new tracing.InMemorySpanExporter();
    const provider = new node.NodeTracerProvider({
      spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
    });
    // Workers are shared between test files: replace the global provider only
    // for this test, as a second registration would be ignored.
    const originalProvider = trace.getTracerProvider();
    trace.disable();
    provider.register();
    const started: Span[] = [];
    try {
      const tracer = trace.getTracer("test");
      app.addHook("preHandler", (request, _reply, done) => {
        const serverSpan = tracer.startSpan(`${request.method} server`);
        const handlerSpan = tracer.startSpan(
          "request handler",
          {},
          trace.setSpan(context.active(), serverSpan),
        );
        addChildSpanToSpan(serverSpan, handlerSpan);
        const errorTrackingSpan = tracer.startSpan(
          `${request.method} error tracking server`,
          { root: true },
        );
        rememberErrorTrackingServerSpan(errorTrackingSpan, request.raw);
        started.push(serverSpan, handlerSpan, errorTrackingSpan);
        context.with(trace.setSpan(context.active(), handlerSpan), done);
      });
      config.mcpGateway.subscriptionMaxDurationMs = 50;
      const { token, url } = await setup({
        makeAgent,
        makeOrganization,
        makeServiceAccountToken,
      });

      const send = (method: string, body: Record<string, unknown>) =>
        fetch(url, {
          method: "POST",
          signal: AbortSignal.timeout(5_000),
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token.value}`,
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": method,
          },
          body: JSON.stringify({ jsonrpc: "2.0", method, ...body }),
        });
      await (
        await send("subscriptions/listen", {
          params: { notifications: { toolsListChanged: true } },
          id: 44,
        })
      ).text();
      await (await send("server/discover", { id: 45 })).text();
      for (const span of started) span.end();

      const methodsOn = (name: string) =>
        exporter
          .getFinishedSpans()
          .filter((span) => span.name === name)
          .map((span) => span.attributes[ATTR_MCP_METHOD_NAME]);
      for (const name of ["POST server", "POST error tracking server"]) {
        const methods = methodsOn(name);
        expect(methods).toEqual(["subscriptions/listen", "server/discover"]);
        expect(methods.map(isLongLivedMcpStream)).toEqual([true, false]);
      }
      // The method goes on the server spans only, not on the active child.
      expect(methodsOn("request handler")).toEqual([undefined, undefined]);
    } finally {
      await provider.shutdown();
      trace.disable();
      context.disable();
      propagation.disable();
      trace.setGlobalTracerProvider(originalProvider);
    }
  });
});
