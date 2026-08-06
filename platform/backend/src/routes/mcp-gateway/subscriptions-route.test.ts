/**
 * subscriptions/listen through the real gateway route, over a real socket.
 *
 * `inject` cannot exercise a hijacked never-ending response, so these listen on
 * an ephemeral port and read the SSE stream with fetch — which is also exactly
 * how a client consumes it.
 */

import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { TeamTokenModel } from "@/models";
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
  }: {
    makeAgent: (args?: Record<string, unknown>) => Promise<{ id: string }>;
    makeOrganization: () => Promise<{ id: string }>;
  }) {
    const agent = await makeAgent();
    const org = await makeOrganization();
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Org Token",
      teamId: null,
      isOrganizationToken: true,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    return { agent, token, url: `http://127.0.0.1:${port}/v1/mcp/${agent.id}` };
  }

  test("opens an SSE stream whose first event is the acknowledgment", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const { token, url } = await setup({ makeAgent, makeOrganization });

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

  test("a legacy client gets method-not-found, not a stream", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const { token, url } = await setup({ makeAgent, makeOrganization });

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
  }) => {
    const { token, url } = await setup({ makeAgent, makeOrganization });

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
  }) => {
    const { token, url } = await setup({ makeAgent, makeOrganization });

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
});
