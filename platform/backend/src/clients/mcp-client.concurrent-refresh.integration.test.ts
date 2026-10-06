/**
 * REAL reproduction (no SDK mocks) of parallel tool calls against one OAuth
 * remote MCP server whose access token expired while no client was cached —
 * the shape of an unattended daily run fanning out several calls at once.
 *
 * The only mocked boundary is the provider's token endpoint
 * (`refreshOAuthToken`), which rotates the stored access token.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Server as McpSdkServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { vi } from "vitest";
import config from "@/config";
import {
  AgentModel,
  AgentToolModel,
  InternalMcpCatalogModel,
  McpServerModel,
  ToolModel,
} from "@/models";
import * as oauthRoutes from "@/routes/oauth";
import { secretManager } from "@/secrets-manager";
import { instanceAnalyticsService } from "@/services/instance-analytics";
import { afterEach, describe, expect, test } from "@/test";
import { agentOwner } from "@/types";
import mcpClient from "./mcp-client";

describe("parallel tool calls on one OAuth remote MCP server", () => {
  let upstream: Awaited<ReturnType<typeof startSessionServer>> | undefined;

  afterEach(async () => {
    instanceAnalyticsService.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await mcpClient.disconnectAll();
    await upstream?.close();
    upstream = undefined;
  });

  test("no call fails after the token expired overnight", async ({
    makeUser,
  }) => {
    upstream = await startSessionServer();
    const { agent, user, secret } = await installOAuthServer({
      makeUser,
      url: upstream.url,
      expiresAt: Date.now() - 60_000,
    });

    let generation = 0;
    vi.spyOn(oauthRoutes, "refreshOAuthToken").mockImplementation(async () => {
      await sleep(REFRESH_LATENCY_MS);
      generation += 1;
      upstream?.setValidToken(`token-${generation}`);
      await secretManager().updateSecret(secret.id, {
        access_token: `token-${generation}`,
        refresh_token: `refresh-${generation}`,
        expires_at: Date.now() + 8 * 3_600_000,
      });
      return { ok: true };
    });

    // The upstream rejects the overnight token until a refresh rotates it.
    upstream.setValidToken("token-rotated-upstream");

    expect(await fanOut({ agentId: agent.id, userId: user.id })).toEqual([]);
  });

  test("no call fails when the upstream forgets a cached session", async ({
    makeUser,
  }) => {
    upstream = await startSessionServer();
    upstream.setValidToken("token-0");
    const { agent, user } = await installOAuthServer({
      makeUser,
      url: upstream.url,
      expiresAt: Date.now() + 8 * 3_600_000,
    });

    // Warm the cached client, then restart the upstream: every session id it
    // issued is now unknown and answers 404 "Session not found".
    expect(
      await fanOut({ agentId: agent.id, userId: user.id, count: 1 }),
    ).toEqual([]);
    upstream.forgetSessions();

    expect(await fanOut({ agentId: agent.id, userId: user.id })).toEqual([]);
  });

  test("cold fan-out teardown leaves no SSE retry in later analytics fetches", async ({
    makeUser,
  }) => {
    upstream = await startSessionServer({ initializationLatencyMs: 150 });
    upstream.setValidToken("token-0");
    const { agent, user } = await installOAuthServer({
      makeUser,
      url: upstream.url,
      expiresAt: Date.now() + 8 * 3_600_000,
    });
    expect(await fanOut({ agentId: agent.id, userId: user.id })).toEqual([]);

    vi.useFakeTimers();
    await mcpClient.disconnectAll();
    await upstream.close();
    // Let real socket EOF reach the SDK's stream reader and schedule its retry
    // before advancing the later consumer's fake clock.
    await delay(50);

    const calls: {
      url: string;
      method?: string;
      body?: unknown;
      stack?: string;
    }[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method,
        body: init?.body,
        stack: new Error("fetch callsite").stack,
      });
      return new Response(null, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    config.analytics.enabled = true;
    config.analytics.posthog = {
      key: "test-key",
      host: "https://analytics.example.com",
    };
    await instanceAnalyticsService.start();
    await vi.advanceTimersByTimeAsync(1_100);

    expect(calls, JSON.stringify(calls, null, 2)).toHaveLength(2);
    expect(
      fetchMock.mock.calls.map(
        ([, init]) => JSON.parse(String(init?.body)).event,
      ),
    ).toEqual(["instance_started", "instance_heartbeat"]);
  });

  test("cold calls preserve A/B/A passthrough header contexts", async ({
    makeUser,
  }) => {
    upstream = await startSessionServer({ initializationLatencyMs: 150 });
    upstream.setValidToken("token-0");
    const { agent, user } = await installOAuthServer({
      makeUser,
      url: upstream.url,
      expiresAt: Date.now() + 8 * 3_600_000,
    });
    expect(
      await fanOut({
        agentId: agent.id,
        userId: user.id,
        count: 3,
        contexts: ["A", "B", "A"],
      }),
    ).toEqual([]);
    expect(upstream.toolContexts.sort((a, b) => a.index - b.index)).toEqual([
      { index: 0, context: "A" },
      { index: 1, context: "B" },
      { index: 2, context: "A" },
    ]);
  });
});

// =============================================================================
// Internal
// =============================================================================

/** Install an OAuth remote server and assign its one tool to a new agent. */
async function installOAuthServer(params: {
  makeUser: (overrides: { email: string }) => Promise<{ id: string }>;
  url: string;
  expiresAt: number;
}) {
  const user = await params.makeUser({ email: `${randomUUID()}@example.com` });
  const agent = await AgentModel.create({
    name: "Fan-out agent",
    scope: "org",
    teams: [],
  });
  const catalog = await InternalMcpCatalogModel.create({
    name: "fanout-oauth",
    serverType: "remote",
    serverUrl: params.url,
    oauthConfig: {
      name: "Fan-out",
      server_url: params.url,
      client_id: "client",
      redirect_uris: ["http://localhost:3000/callback"],
      scopes: ["repo"],
      default_scopes: ["repo"],
      supports_resource_metadata: false,
    },
  });
  const secret = await secretManager().createSecret(
    {
      access_token: "token-0",
      refresh_token: "refresh-0",
      expires_at: params.expiresAt,
    },
    "fanout-oauth-secret",
  );
  const server = await McpServerModel.create({
    name: "fanout-oauth",
    catalogId: catalog.id,
    secretId: secret.id,
    serverType: "remote",
    ownerId: user.id,
  });
  const tool = await ToolModel.createToolIfNotExists({
    name: "fanout-oauth__list_advisories",
    description: "List advisories",
    parameters: {},
    catalogId: catalog.id,
  });
  await AgentToolModel.create(agent.id, tool.id, { mcpServerId: server.id });
  return { agent, user, secret };
}

/**
 * Fire parallel calls a few milliseconds apart, the way an agent turn fans
 * out, and return the ones that failed.
 */
async function fanOut(params: {
  agentId: string;
  userId: string;
  count?: number;
  contexts?: string[];
}) {
  const results = await Promise.all(
    Array.from({ length: params.count ?? FAN_OUT }, async (_, index) => {
      await sleep(index * 5);
      return mcpClient.executeToolCallForOwner(
        {
          id: `call_${index}`,
          name: "fanout-oauth__list_advisories",
          arguments: { index },
        },
        agentOwner(params.agentId),
        {
          tokenId: "token",
          teamId: null,
          isOrganizationToken: false,
          userId: params.userId,
          passthroughHeaders: params.contexts
            ? { "X-Mcp-Context": params.contexts[index] }
            : undefined,
        },
      );
    }),
  );
  return results
    .map((result, index) => ({ index, result }))
    .filter(({ result }) => result.isError)
    .map(({ index, result }) => ({
      index,
      text: JSON.stringify(result.content).slice(0, 200),
    }));
}

const FAN_OUT = 6;
const REFRESH_LATENCY_MS = 150;
const TOOL_LATENCY_MS = 400;

/**
 * A stateful streamable-HTTP MCP server that issues session ids, answers 401
 * for any bearer other than the current valid token, and serves one slow tool
 * so parallel calls overlap.
 */
async function startSessionServer(
  options: { initializationLatencyMs?: number } = {},
) {
  let validToken = "";
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const toolContexts: { index: number; context: string | undefined }[] = [];

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== `Bearer ${validToken}`) {
        res
          .writeHead(401, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "invalid_token" }));
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = body ? JSON.parse(body) : undefined;
      if (parsed?.method === "tools/call") {
        toolContexts.push({
          index: parsed.params.arguments.index,
          context: req.headers["x-mcp-context"] as string | undefined,
        });
      }
      const sessionId = req.headers["mcp-session-id"];
      let transport =
        typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (!transport) {
        if (typeof sessionId === "string") {
          res.writeHead(404).end("Session not found");
          return;
        }
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, created);
          },
        });
        const mcp = new McpSdkServer(
          { name: "fanout", version: "1.0.0" },
          { capabilities: { tools: {} } },
        );
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [{ name: "list_advisories", inputSchema: { type: "object" } }],
        }));
        mcp.setRequestHandler(CallToolRequestSchema, async () => {
          await sleep(TOOL_LATENCY_MS);
          return { content: [{ type: "text", text: "[]" }] };
        });
        await mcp.connect(created);
        transport = created;
        await sleep(options.initializationLatencyMs ?? 0);
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
    toolContexts,
    setValidToken: (token: string) => {
      validToken = token;
    },
    forgetSessions: () => {
      sessions.clear();
    },
    close: async () => {
      for (const transport of sessions.values()) await transport.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
