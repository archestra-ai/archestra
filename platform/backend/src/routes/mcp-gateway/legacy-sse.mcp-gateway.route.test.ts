import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { TeamTokenModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import mcpGatewayRoutes from "./index";

// A stream's session record lives in the shared cache, which is Keyv over a
// real PostgreSQL connection — the unit suite runs on PGlite and never starts
// it, so the real manager would throw on the first write. The canonical fake
// has real cache semantics.
vi.mock("@/cache-manager");

/**
 * The legacy HTTP+SSE transport is driven end to end with the SDK's own
 * deprecated client, over real sockets: the stream is a hijacked reply that
 * `app.inject` could never finish reading.
 */
describe("MCP Gateway legacy HTTP+SSE transport", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildGatewayApp();
    await app.register(mcpGatewayRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("an SDK SSE client connects, lists, and calls tools over one stream", async ({
    makeAgent,
    makeOrganization,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    await seedAndAssignArchestraTools(agent.id);
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Gateway token",
      teamId: null,
      isOrganizationToken: true,
    });
    let streamsOpened = 0;
    app.addHook("onRequest", async (request) => {
      if (request.method === "GET") streamsOpened += 1;
    });
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const client = new Client({ name: "legacy-sse-test", version: "1.0.0" });
    const errors: Error[] = [];
    client.onerror = (error) => errors.push(error);

    try {
      await client.connect(
        new SSEClientTransport(new URL(`/v1/mcp/${agent.slug}`, origin), {
          requestInit: {
            headers: { authorization: `Bearer ${token.value}` },
          },
        }),
      );

      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("archestra__whoami");

      const result = await client.callTool({
        name: "archestra__whoami",
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining(agent.id),
          }),
        ]),
      );
      expect(errors).toEqual([]);
      // Everything rode the one stream opened at connect time.
      expect(streamsOpened).toBe(1);
    } finally {
      await client.close();
    }
  });

  test("delivers concurrent tool responses from a replica that does not hold the stream", async ({
    makeAgent,
    makeOrganization,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    await seedAndAssignArchestraTools(agent.id);
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Gateway token",
      teamId: null,
      isOrganizationToken: true,
    });
    // A second plugin instance is a second replica: its own stream registry,
    // the same database.
    const otherReplica = buildGatewayApp();
    await otherReplica.register(mcpGatewayRoutes);
    const streamOrigin = await app.listen({ host: "127.0.0.1", port: 0 });
    const postOrigin = await otherReplica.listen({
      host: "127.0.0.1",
      port: 0,
    });
    const streamAbort = new AbortController();

    try {
      const stream = await fetch(`${streamOrigin}/v1/mcp/${agent.slug}`, {
        headers: {
          authorization: `Bearer ${token.value}`,
          accept: "text/event-stream",
        },
        signal: streamAbort.signal,
      });
      expect(stream.status).toBe(200);
      expect(stream.headers.get("content-type")).toContain("text/event-stream");
      const events = readSseEvents(stream.body as ReadableStream<Uint8Array>);

      const endpoint = await events.next();
      expect(endpoint.value?.event).toBe("endpoint");
      expect(endpoint.value?.data).toMatch(
        new RegExp(
          `^/v1/mcp/${agent.slug}/messages\\?sessionId=[0-9a-f-]{36}$`,
        ),
      );

      const posted = await Promise.all(
        [7, 8, 9].map((id) =>
          postMessage({
            url: new URL(endpoint.value?.data ?? "", postOrigin).toString(),
            token: token.value,
            message:
              id === 7
                ? { jsonrpc: "2.0", id, method: "tools/list", params: {} }
                : {
                    jsonrpc: "2.0",
                    id,
                    method: "tools/call",
                    params: { name: "archestra__whoami", arguments: {} },
                  },
          }),
        ),
      );
      expect(posted.map((response) => response.status)).toEqual([
        202, 202, 202,
      ]);

      const replies = [];
      for (let i = 0; i < 3; i++) {
        const answer = await nextEventWithin(events, 3_000);
        expect(answer?.event).toBe("message");
        replies.push(JSON.parse(answer?.data ?? "{}"));
      }
      expect(replies.map((message) => message.id).sort()).toEqual([7, 8, 9]);
      expect(replies.find((message) => message.id === 7).result.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "archestra__whoami" }),
        ]),
      );
      for (const message of replies.filter((message) => message.id !== 7)) {
        expect(message.result.isError).not.toBe(true);
        expect(message.result.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining(agent.id),
            }),
          ]),
        );
      }
    } finally {
      streamAbort.abort();
      await otherReplica.close();
    }
  });

  test("shutting the server down ends a held stream instead of draining forever", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Gateway token",
      teamId: null,
      isOrganizationToken: true,
    });
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const streamAbort = new AbortController();

    try {
      const stream = await fetch(`${origin}/v1/mcp/${agent.slug}`, {
        headers: {
          authorization: `Bearer ${token.value}`,
          accept: "text/event-stream",
        },
        signal: streamAbort.signal,
      });
      expect(stream.status).toBe(200);

      // The held stream is itself one of the in-flight requests the HTTP
      // server waits on, so a close that only ends streams afterwards hangs.
      const startedAt = Date.now();
      await app.close();
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      streamAbort.abort();
    }
  });

  test("refuses a message POSTed with a session id minted for another credential", async ({
    makeAgent,
    makeOrganization,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    await seedAndAssignArchestraTools(agent.id);
    const streamToken = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Stream token",
      teamId: null,
      isOrganizationToken: true,
    });
    // A second credential for the same organization and the same profile:
    // authorized for the gateway, but not for this stream.
    const otherToken = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Other token",
      teamId: null,
      isOrganizationToken: true,
    });
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const streamAbort = new AbortController();

    try {
      const stream = await fetch(`${origin}/v1/mcp/${agent.slug}`, {
        headers: {
          authorization: `Bearer ${streamToken.value}`,
          accept: "text/event-stream",
        },
        signal: streamAbort.signal,
      });
      const events = readSseEvents(stream.body as ReadableStream<Uint8Array>);
      const endpoint = await events.next();
      expect(endpoint.value?.event).toBe("endpoint");

      const posted = await fetch(new URL(endpoint.value?.data ?? "", origin), {
        method: "POST",
        headers: {
          authorization: `Bearer ${otherToken.value}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      });
      expect(posted.status).toBe(404);
      expect(await posted.json()).toMatchObject({ error: "Not Found" });

      // Nothing the other credential asked for reaches the stream's holder.
      expect(await nextEventWithin(events, 2_000)).toBeNull();
    } finally {
      streamAbort.abort();
    }
  });

  test("refuses a well-formed session id no stream ever had, parking nothing", async ({
    makeAgent,
    makeOrganization,
    seedAndAssignArchestraTools,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    await seedAndAssignArchestraTools(agent.id);
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Gateway token",
      teamId: null,
      isOrganizationToken: true,
    });
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });

    const posted = await postMessage({
      url: `${origin}/v1/mcp/${agent.slug}/messages?sessionId=${randomUUID()}`,
      token: token.value,
      message: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });

    expect(posted.status).toBe(404);
  });

  test("refuses a message POSTed after its stream closed", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      agentType: "mcp_gateway",
    });
    const token = await TeamTokenModel.create({
      organizationId: org.id,
      name: "Gateway token",
      teamId: null,
      isOrganizationToken: true,
    });
    const origin = await app.listen({ host: "127.0.0.1", port: 0 });
    const streamAbort = new AbortController();

    const stream = await fetch(`${origin}/v1/mcp/${agent.slug}`, {
      headers: {
        authorization: `Bearer ${token.value}`,
        accept: "text/event-stream",
      },
      signal: streamAbort.signal,
    });
    const events = readSseEvents(stream.body as ReadableStream<Uint8Array>);
    const endpoint = await events.next();
    const messageUrl = new URL(endpoint.value?.data ?? "", origin).toString();

    streamAbort.abort();

    // Wait for the server to finish closing the stream. The probe is a
    // notification, which is answered by nothing: a probe that lands before
    // the close is accepted but parks no row for the assertion below to find.
    const deadline = Date.now() + 3_000;
    let probe = { status: 0 };
    while (probe.status !== 404 && Date.now() < deadline) {
      probe = await postMessage({
        url: messageUrl,
        token: token.value,
        message: { jsonrpc: "2.0", method: "notifications/initialized" },
      });
    }
    expect(probe.status).toBe(404);

    const posted = await postMessage({
      url: messageUrl,
      token: token.value,
      message: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    });

    expect(posted.status).toBe(404);
  });
});

function buildGatewayApp(): FastifyInstance {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app;
}

/** POST one JSON-RPC message to a stream's announced message endpoint. */
async function postMessage(params: {
  url: string;
  token: string;
  message: Record<string, unknown>;
}): Promise<Response> {
  return fetch(params.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${params.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(params.message),
  });
}

/** Yield SSE events carrying data; keep-alive comments are skipped. */
async function* readSseEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of raw.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (data.length > 0) yield { event, data: data.join("\n") };
      boundary = buffer.indexOf("\n\n");
    }
  }
}

/** The next event carrying data, or null if none arrives within `ms`. */
async function nextEventWithin(
  events: AsyncGenerator<{ event: string; data: string }>,
  ms: number,
): Promise<{ event: string; data: string } | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      // A rejection here means the stream went away, which is "no event".
      events.next().then(
        (result) => result.value ?? null,
        () => null,
      ),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
