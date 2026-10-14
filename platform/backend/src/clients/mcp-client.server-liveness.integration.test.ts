/**
 * Background-task tool calls (an upstream timeout past the synchronous one)
 * against a REAL streamable-HTTP MCP server, no SDK mocks. A server that stops
 * answering must end the call within about the synchronous timeout instead of
 * the task TTL; a server that keeps answering pings keeps the call alive.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import config from "@/config";
import {
  AgentModel,
  AgentToolModel,
  InternalMcpCatalogModel,
  McpServerModel,
  ToolModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { agentOwner } from "@/types";
import mcpClient from "./mcp-client";

describe("background tool calls check that the MCP server still answers", () => {
  let upstream: Awaited<ReturnType<typeof startUpstream>> | undefined;
  const defaultSyncTimeoutMs = config.mcpGateway.toolCallTimeoutMs;

  beforeEach(() => {
    config.mcpGateway.toolCallTimeoutMs = SYNC_TIMEOUT_MS;
  });

  afterEach(async () => {
    config.mcpGateway.toolCallTimeoutMs = defaultSyncTimeoutMs;
    await mcpClient.disconnectAll();
    await upstream?.close();
    upstream = undefined;
  });

  test("a call on a server that stops answering ends within about the sync timeout, and the next call reconnects", async ({
    makeUser,
  }) => {
    upstream = await startUpstream();
    const install = await installServer({ makeUser, url: upstream.url });

    const startedAt = performance.now();
    // Detached: it throws so the task row settles as failed.
    await expect(callTool({ ...install, tool: "hang" })).rejects.toThrow(
      "The MCP server stopped answering, so this tool call was stopped.",
    );
    // checkAfter (sync timeout) + one unanswered ping, nowhere near the TTL.
    expect(performance.now() - startedAt).toBeLessThan(5_000);

    // The dead client was dropped: the next call opens a fresh session rather
    // than waiting on the one that went silent.
    const next = await callTool({ ...install, tool: "slow", ms: 10 });
    expect(next.isError).toBe(false);
    expect(upstream.activity.initializations).toBe(2);
  });

  test("a healthy server keeps a call alive past the sync timeout", async ({
    makeUser,
  }) => {
    upstream = await startUpstream();
    const install = await installServer({ makeUser, url: upstream.url });

    const startedAt = performance.now();
    const result = await callTool({ ...install, tool: "slow", ms: 2_500 });

    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "slow done" }]);
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(2_500);
    // The check ran and the server answered it.
    expect(upstream.activity.pings).toBeGreaterThan(0);
  });

  test("a server that answers pings with an error still counts as answering", async ({
    makeUser,
  }) => {
    upstream = await startUpstream({ rejectPings: true });
    const install = await installServer({ makeUser, url: upstream.url });

    const result = await callTool({ ...install, tool: "slow", ms: 2_500 });

    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "slow done" }]);
    expect(upstream.activity.pings).toBeGreaterThan(0);
  });

  test("a call queued behind a silent server's call does not hang", async ({
    makeUser,
  }) => {
    upstream = await startUpstream();
    const install = await installServer({ makeUser, url: upstream.url });

    // An elicitation-capable call runs one at a time per connection, the same
    // limit a stdio server gets, so the second call queues behind the first.
    const elicitationHandler = async () => ({ action: "decline" as const });
    const stuck = callTool({ ...install, tool: "hang", elicitationHandler });
    const queued = callTool({
      ...install,
      tool: "slow",
      ms: 10,
      elicitationHandler,
    });

    const [stuckOutcome, queuedOutcome] = await Promise.allSettled([
      stuck,
      queued,
    ]);
    expect(stuckOutcome).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        message: expect.stringContaining("stopped answering"),
      }),
    });
    expect(queuedOutcome).toMatchObject({
      status: "fulfilled",
      value: { isError: false, content: [{ type: "text", text: "slow done" }] },
    });
  });

  test("a queued call ends too when the wedged server also ignores its reconnect", async ({
    makeUser,
  }) => {
    upstream = await startUpstream({ wedgeWholeServer: true });
    const install = await installServer({ makeUser, url: upstream.url });

    const elicitationHandler = async () => ({ action: "decline" as const });
    const startedAt = performance.now();
    const outcomes = await Promise.allSettled([
      callTool({ ...install, tool: "hang", elicitationHandler }),
      callTool({ ...install, tool: "slow", ms: 10, elicitationHandler }),
    ]);

    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringContaining("stopped answering"),
        }),
      });
    }
    // The stuck call's check plus one unanswered handshake, not the TTL.
    expect(performance.now() - startedAt).toBeLessThan(8_000);
  });

  test("a closed connection fails a call inline with a result, and a background call with a throw", async ({
    makeUser,
  }) => {
    // Longer than the other tests' timeout, so the early call can reach the
    // server and be closed well inside it even on a loaded test machine.
    config.mcpGateway.toolCallTimeoutMs = CLOSE_TEST_SYNC_TIMEOUT_MS;
    upstream = await startUpstream();
    const { activity } = upstream;
    const install = await installServer({ makeUser, url: upstream.url });

    // Closed before the sync timeout: the caller is still waiting inline (a
    // chat call detaches only at the task threshold), so it gets a result.
    const early = callTool({ ...install, tool: "slow", ms: 15_000 });
    await waitUntil(() => activity.slowCalls === 1);
    await mcpClient.disconnectAll();
    expect(await early).toMatchObject({
      isError: true,
      content: [
        {
          type: "text",
          text: expect.stringContaining(
            "The connection to the MCP server closed",
          ),
        },
      ],
    });

    // Closed after it: by then the call runs as a background task. The client
    // decides by how long the call has run, so twice the sync timeout after
    // the server received it is safely past that bound.
    const late = callTool({ ...install, tool: "slow", ms: 15_000 });
    await waitUntil(() => activity.slowCalls === 2);
    await sleep(CLOSE_TEST_SYNC_TIMEOUT_MS * 2);
    await mcpClient.disconnectAll();
    await expect(late).rejects.toThrow(
      "The connection to the MCP server closed",
    );
  });
});

// =============================================================================
// Helpers
// =============================================================================

const SYNC_TIMEOUT_MS = 400;
const CLOSE_TEST_SYNC_TIMEOUT_MS = 2_000;
const TASK_TTL_MS = 30 * 60 * 1000;

async function installServer(params: {
  makeUser: (overrides: { email: string }) => Promise<{ id: string }>;
  url: string;
}) {
  const user = await params.makeUser({ email: `${randomUUID()}@example.com` });
  const agent = await AgentModel.create({
    name: "Liveness agent",
    scope: "org",
    teams: [],
  });
  const catalog = await InternalMcpCatalogModel.create({
    name: "liveness",
    serverType: "remote",
    serverUrl: params.url,
  });
  const server = await McpServerModel.create({
    name: "liveness",
    catalogId: catalog.id,
    serverType: "remote",
    ownerId: user.id,
  });
  for (const name of ["hang", "slow"]) {
    const tool = await ToolModel.createToolIfNotExists({
      name: `liveness__${name}`,
      description: name,
      parameters: {},
      catalogId: catalog.id,
    });
    await AgentToolModel.create(agent.id, tool.id, { mcpServerId: server.id });
  }
  return { agentId: agent.id, userId: user.id };
}

function callTool(params: {
  agentId: string;
  userId: string;
  tool: "hang" | "slow";
  ms?: number;
  elicitationHandler?: () => Promise<{ action: "decline" }>;
}) {
  return mcpClient.executeToolCallForOwner(
    {
      id: `call_${randomUUID()}`,
      name: `liveness__${params.tool}`,
      arguments: { ms: params.ms ?? 0 },
    },
    agentOwner(params.agentId),
    {
      tokenId: "token",
      teamId: null,
      isOrganizationToken: false,
      userId: params.userId,
    },
    {
      // What a call that detached into a background task carries.
      upstreamTimeoutMs: TASK_TTL_MS,
      ...(params.elicitationHandler
        ? { elicitationHandler: params.elicitationHandler }
        : {}),
    },
  );
}

/**
 * A stateful streamable-HTTP MCP server. `hang` never returns, and from then
 * on the server holds every request on that session open unanswered, pings
 * included — a wedged server. Other sessions are still served, unless
 * `wedgeWholeServer` holds every later request, new sessions included.
 */
async function startUpstream(
  options: { wedgeWholeServer?: boolean; rejectPings?: boolean } = {},
) {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const wedgedSessions = new Set<string>();
  const activity = { initializations: 0, pings: 0, slowCalls: 0 };

  const httpServer = http.createServer(async (req, res) => {
    try {
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = body ? JSON.parse(body) : undefined;
      const sessionId = req.headers["mcp-session-id"];
      if (
        (options.wedgeWholeServer && wedgedSessions.size > 0) ||
        (typeof sessionId === "string" && wedgedSessions.has(sessionId))
      ) {
        return;
      }
      if (parsed?.method === "ping") activity.pings += 1;
      if (parsed?.method === "ping" && options.rejectPings) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id,
            error: { code: -32601, message: "Method not found" },
          }),
        );
        return;
      }

      let transport =
        typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (!transport) {
        activity.initializations += 1;
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, created);
          },
        });
        const mcp = new McpSdkServer(
          { name: "liveness", version: "1.0.0" },
          { capabilities: { tools: {} } },
        );
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: ["hang", "slow"].map((name) => ({
            name,
            inputSchema: { type: "object" as const },
          })),
        }));
        mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
          if (request.params.name === "hang") {
            if (created.sessionId) wedgedSessions.add(created.sessionId);
            return new Promise<never>(() => {});
          }
          activity.slowCalls += 1;
          await sleep(Number(request.params.arguments?.ms ?? 0));
          return { content: [{ type: "text", text: "slow done" }] };
        });
        await mcp.connect(created);
        transport = created;
      }
      await transport.handleRequest(req, res, parsed);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const { port } = httpServer.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    activity,
    close: async () => {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(condition: () => boolean) {
  const deadline = performance.now() + 10_000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("Condition not met");
    await sleep(10);
  }
}
