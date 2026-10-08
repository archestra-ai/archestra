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
import type { Client as McpSdkClient } from "@modelcontextprotocol/sdk/client/index.js";
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
import McpHttpSessionModel from "@/models/mcp-http-session";
import * as oauthRoutes from "@/routes/oauth";
import { secretManager } from "@/secrets-manager";
import { instanceAnalyticsService } from "@/services/instance-analytics";
import { afterEach, describe, expect, test } from "@/test";
import { agentOwner } from "@/types";
import mcpClient from "./mcp-client";
import type { McpElicitationHandler } from "./mcp-elicitation";

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
    await expectNoSseRetriesAfterDisconnect(upstream);
  });

  test("cold stale-session recovery shares one fresh handshake with waiting HTTP callers", async ({
    makeUser,
  }) => {
    const initializing = gate();
    const releaseInitialization = gate();
    upstream = await startSessionServer({
      expireFirstToolCall: true,
      beforeInitialize: async (attempt) => {
        if (attempt === 1) return;
        initializing.resolve();
        await releaseInitialization.promise;
      },
    });
    upstream.setValidToken("token-0");
    const { agent, user, connectionKey } = await installOAuthServer({
      makeUser,
      url: upstream.url,
      expiresAt: Date.now() + 8 * 3_600_000,
    });
    // Observe attempts without replacing the real client or SDK implementation.
    const getClient = vi.spyOn(
      mcpClient as unknown as {
        getOrCreateClient: (...args: unknown[]) => Promise<unknown>;
      },
      "getOrCreateClient",
    );
    let settled = 0;
    const calls = [
      fanOut({ agentId: agent.id, userId: user.id, count: 1 }).finally(() => {
        settled += 1;
      }),
    ];
    try {
      await initializing.promise;
      // The cold client's first RPC lost its session after initialization. These
      // callers arrive while its retry is blocked, with no reusable client yet.
      calls.push(
        fanOut({
          agentId: agent.id,
          userId: user.id,
          startIndex: 1,
          count: FAN_OUT - 1,
        }).finally(() => {
          settled += 1;
        }),
      );
      await vi.waitFor(() =>
        expect(getClient.mock.calls.length).toBeGreaterThanOrEqual(5),
      );
      expect(settled).toBe(0);
      expect(upstream.activity.initializations).toBe(2);
      expect(upstream.activity.expiredToolCalls).toBe(1);
      expect(upstream.activity.toolAttempts).toEqual([0]);
    } finally {
      releaseInitialization.resolve();
      await Promise.all(calls);
    }
    expect(await Promise.all(calls)).toEqual([[], []]);
    expect(upstream.activity.initializations).toBe(2);
    expect(upstream.activity.maxInitializations).toBe(1);
    // One initial session was lost; all six calls share exactly one replacement.
    expect(upstream.initializedSessions).toHaveLength(2);
    expect(upstream.activity.maxToolCalls).toBeGreaterThan(1);
    expect(upstream.activity.maxToolCalls).toBeLessThanOrEqual(4);
    expect(upstream.activity.toolAttempts.toSorted((a, b) => a - b)).toEqual([
      0, 0, 1, 2, 3, 4, 5,
    ]);
    expect(await McpHttpSessionModel.findByConnectionKey(connectionKey)).toBe(
      upstream.initializedSessions[1],
    );
    await expectNoSseRetriesAfterDisconnect(upstream);
  });

  test("a stale tool-call retry keeps the elicitation limit of one and its own handler", async ({
    makeUser,
  }) => {
    const questionStarted = gate();
    const releaseQuestion = gate();
    upstream = await startSessionServer({
      expireFirstToolCall: true,
      elicit: true,
    });
    upstream.setValidToken("token-0");
    const { agent, user } = await installOAuthServer({
      makeUser,
      url: upstream.url,
      expiresAt: Date.now() + 8 * 3_600_000,
    });
    const limiter = vi.spyOn(
      (
        mcpClient as unknown as {
          connectionLimiter: {
            runWithLimit: (...args: unknown[]) => Promise<unknown>;
          };
        }
      ).connectionLimiter,
      "runWithLimit",
    );
    const questions: { handler: number; tool: number }[] = [];
    const elicitationHandler =
      (index: number): McpElicitationHandler =>
      async (request) => {
        questions.push({
          handler: index,
          tool: Number(request.params.message),
        });
        if (index === 0) {
          questionStarted.resolve();
          await releaseQuestion.promise;
        }
        return { action: "accept", content: { index } };
      };
    const calls = [
      fanOut({
        agentId: agent.id,
        userId: user.id,
        count: 1,
        elicitationHandler,
      }),
    ];
    try {
      await questionStarted.promise;
      calls.push(
        fanOut({
          agentId: agent.id,
          userId: user.id,
          startIndex: 1,
          count: FAN_OUT - 1,
          elicitationHandler,
        }),
      );
      await vi.waitFor(() => expect(limiter).toHaveBeenCalledTimes(FAN_OUT));
      expect(upstream.activity.toolAttempts).toEqual([0, 0]);
      expect(upstream.activity.initializations).toBe(2);
      expect(questions).toEqual([{ handler: 0, tool: 0 }]);
    } finally {
      releaseQuestion.resolve();
      await Promise.all(calls);
    }
    expect(await Promise.all(calls)).toEqual([[], []]);
    expect(upstream.activity.maxToolCalls).toBe(1);
    expect(upstream.activity.expiredToolCalls).toBe(1);
    expect(upstream.activity.toolAttempts).toEqual([0, 0, 1, 2, 3, 4, 5]);
    expect(questions).toEqual(
      Array.from({ length: FAN_OUT }, (_, index) => ({
        handler: index,
        tool: index,
      })),
    );
    expect(upstream.elicitationAnswers).toEqual(
      Array.from({ length: FAN_OUT }, (_, index) => ({ index, answer: index })),
    );
    await expectNoSseRetriesAfterDisconnect(upstream);
  });

  test("a delayed old-session 404 after recovery preserves the replacement session and client", async ({
    makeUser,
  }) => {
    const firstOldCall = gate();
    const bothOldCalls = gate();
    const releaseLateFailure = gate();
    upstream = await startSessionServer({
      beforeStaleToolResponse: async (index) => {
        if (index === 0) {
          firstOldCall.resolve();
          await bothOldCalls.promise;
        } else {
          bothOldCalls.resolve();
          await releaseLateFailure.promise;
        }
      },
    });
    upstream.setValidToken("token-0");
    const { agent, user, connectionKey } = await installOAuthServer({
      makeUser,
      url: upstream.url,
      expiresAt: Date.now() + 8 * 3_600_000,
    });
    const state = mcpClient as unknown as {
      activeConnections: Map<string, McpSdkClient>;
      activeConnectionServerState: Map<string, unknown>;
      sessionRecoveryLocks: Map<string, Promise<void>>;
    };
    const cleanup = vi.spyOn(McpHttpSessionModel, "deleteStaleSession");
    const first = fanOut({ agentId: agent.id, userId: user.id, count: 1 });
    let second: ReturnType<typeof fanOut> | undefined;
    try {
      await firstOldCall.promise;
      const originalClient = state.activeConnections.get(connectionKey);
      if (!originalClient) throw new Error("Missing original MCP client");
      const closeOriginal = vi.spyOn(originalClient, "close");
      second = fanOut({
        agentId: agent.id,
        userId: user.id,
        count: 1,
        startIndex: 1,
      });
      await bothOldCalls.promise;

      // Keep the second original RPC suspended until recovery has completed,
      // including persistence and releasing the recovery lock.
      expect(await first).toEqual([]);
      expect(state.sessionRecoveryLocks.has(connectionKey)).toBe(false);
      const replacementClient = state.activeConnections.get(connectionKey);
      if (!replacementClient) throw new Error("Missing recovered MCP client");
      expect(replacementClient).not.toBe(originalClient);
      const closeReplacement = vi.spyOn(replacementClient, "close");
      const replacementState =
        state.activeConnectionServerState.get(connectionKey);
      const replacementSession =
        await McpHttpSessionModel.findRecordByConnectionKey(connectionKey);
      expect(replacementSession?.sessionId).toBe(
        upstream.initializedSessions[1],
      );
      expect(closeOriginal).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledExactlyOnceWith(
        connectionKey,
        upstream.initializedSessions[0],
      );

      releaseLateFailure.resolve();
      expect(await second).toEqual([]);

      expect(state.activeConnections.get(connectionKey)).toBe(
        replacementClient,
      );
      expect(state.activeConnectionServerState.get(connectionKey)).toEqual(
        replacementState,
      );
      expect(closeOriginal).toHaveBeenCalledTimes(1);
      expect(closeReplacement).not.toHaveBeenCalled();
      expect(upstream.activity.initializations).toBe(2);
      expect(upstream.activity.expiredToolCalls).toBe(2);
      expect(upstream.activity.toolAttempts).toEqual([0, 1, 0, 1]);
      expect(
        await McpHttpSessionModel.findRecordByConnectionKey(connectionKey),
      ).toEqual(replacementSession);
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      bothOldCalls.resolve();
      releaseLateFailure.resolve();
      await Promise.all([first, second]);
    }
    await expectNoSseRetriesAfterDisconnect(upstream);
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

  test("a parked caller revalidates the credential fingerprint after the init-lock wait", async ({
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
        contexts: ["A", "A", "B"],
      }),
    ).toEqual([]);
    expect(upstream.toolContexts.sort((a, b) => a.index - b.index)).toEqual([
      { index: 0, context: "A" },
      { index: 1, context: "A" },
      { index: 2, context: "B" },
    ]);
    // The parked A caller's pre-wait snapshot matched the freshly cached
    // client, but B's transport advanced the shared fingerprint during the
    // wait — the same shape as an OAuth refresh rotating the token under a
    // parked caller. Reusing would have skipped the rebuild a rotation
    // requires, so the parked caller initializes its own client: three
    // handshakes, still serialized to one at a time by the lock.
    expect(upstream.activity.initializations).toBe(3);
    expect(upstream.activity.maxInitializations).toBe(1);
    await expectNoSseRetriesAfterDisconnect(upstream);
  });

  test("a parked caller closes its discarded candidate transport when the cached client is reused", async ({
    makeUser,
  }) => {
    upstream = await startSessionServer({ initializationLatencyMs: 150 });
    upstream.setValidToken("token-0");
    const { agent, user } = await installOAuthServer({
      makeUser,
      url: upstream.url,
      expiresAt: Date.now() + 8 * 3_600_000,
    });
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const closeTransport = vi.spyOn(
      StreamableHTTPClientTransport.prototype,
      "close",
    );

    expect(await fanOut({ agentId: agent.id, userId: user.id })).toEqual([]);

    // One shared handshake; the five parked callers reused the cached client,
    // so each of their freshly-built candidate transports was discarded and
    // must have been closed rather than leaked. (The cached client's own
    // transport is closed later, at disconnect.)
    expect(upstream.activity.initializations).toBe(1);
    expect(closeTransport).toHaveBeenCalledTimes(FAN_OUT - 1);
    await expectNoSseRetriesAfterDisconnect(upstream);
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
  return {
    agent,
    user,
    secret,
    connectionKey: `${catalog.id}:${server.id}`,
  };
}

/**
 * Fire parallel calls a few milliseconds apart, the way an agent turn fans
 * out, and return the ones that failed.
 */
async function fanOut(params: {
  agentId: string;
  userId: string;
  count?: number;
  startIndex?: number;
  contexts?: string[];
  elicitationHandler?: (index: number) => McpElicitationHandler;
}) {
  const results = await Promise.all(
    Array.from({ length: params.count ?? FAN_OUT }, async (_, offset) => {
      const index = (params.startIndex ?? 0) + offset;
      await sleep(offset * 5);
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
        params.elicitationHandler
          ? { elicitationHandler: params.elicitationHandler(index) }
          : undefined,
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
  options: {
    initializationLatencyMs?: number;
    beforeInitialize?: (attempt: number) => Promise<void>;
    expireFirstToolCall?: boolean;
    beforeStaleToolResponse?: (index: number) => Promise<void>;
    elicit?: boolean;
  } = {},
) {
  let validToken = "";
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const transports = new Set<StreamableHTTPServerTransport>();
  const initializedSessions: string[] = [];
  const toolContexts: { index: number; context: string | undefined }[] = [];
  const elicitationAnswers: { index: number; answer: unknown }[] = [];
  const activity = {
    initializations: 0,
    activeInitializations: 0,
    maxInitializations: 0,
    staleRequests: 0,
    expiredToolCalls: 0,
    activeToolCalls: 0,
    maxToolCalls: 0,
    toolAttempts: [] as number[],
  };

  const httpServer = http.createServer(async (req, res) => {
    let initializing = false;
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
        activity.toolAttempts.push(parsed.params.arguments.index);
        toolContexts.push({
          index: parsed.params.arguments.index,
          context: req.headers["x-mcp-context"] as string | undefined,
        });
      }
      const sessionId = req.headers["mcp-session-id"];
      let transport =
        typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
      if (
        typeof sessionId === "string" &&
        sessionId === initializedSessions[0] &&
        parsed?.method === "tools/call" &&
        options.beforeStaleToolResponse
      ) {
        await options.beforeStaleToolResponse(parsed.params.arguments.index);
        activity.expiredToolCalls += 1;
        sessions.delete(sessionId);
        res.writeHead(404).end("Session not found");
        return;
      }
      if (
        transport &&
        parsed?.method === "tools/call" &&
        options.expireFirstToolCall &&
        activity.expiredToolCalls === 0
      ) {
        activity.expiredToolCalls += 1;
        if (typeof sessionId === "string") sessions.delete(sessionId);
        res.writeHead(404).end("Session not found");
        return;
      }
      if (!transport) {
        if (typeof sessionId === "string") {
          activity.staleRequests += 1;
          res.writeHead(404).end("Session not found");
          return;
        }
        initializing = true;
        activity.initializations += 1;
        activity.activeInitializations += 1;
        activity.maxInitializations = Math.max(
          activity.maxInitializations,
          activity.activeInitializations,
        );
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: !options.elicit,
          onsessioninitialized: (id) => {
            sessions.set(id, created);
            initializedSessions.push(id);
          },
        });
        transports.add(created);
        const mcp = new McpSdkServer(
          { name: "fanout", version: "1.0.0" },
          { capabilities: { tools: {} } },
        );
        mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [{ name: "list_advisories", inputSchema: { type: "object" } }],
        }));
        mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
          activity.activeToolCalls += 1;
          activity.maxToolCalls = Math.max(
            activity.maxToolCalls,
            activity.activeToolCalls,
          );
          try {
            const index = Number(request.params.arguments?.index);
            if (options.elicit) {
              const answer = await mcp.elicitInput(
                {
                  message: String(index),
                  requestedSchema: {
                    type: "object",
                    properties: { index: { type: "integer" } },
                    required: ["index"],
                  },
                },
                { relatedRequestId: extra.requestId },
              );
              elicitationAnswers.push({ index, answer: answer.content?.index });
            }
            await sleep(TOOL_LATENCY_MS);
            return { content: [{ type: "text", text: "[]" }] };
          } finally {
            activity.activeToolCalls -= 1;
          }
        });
        await mcp.connect(created);
        transport = created;
        await options.beforeInitialize?.(activity.initializations);
        await sleep(options.initializationLatencyMs ?? 0);
      }
      await transport.handleRequest(req, res, parsed);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    } finally {
      if (initializing) activity.activeInitializations -= 1;
    }
  });

  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve),
  );
  const { port } = httpServer.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    activity,
    initializedSessions,
    toolContexts,
    elicitationAnswers,
    setValidToken: (token: string) => {
      validToken = token;
    },
    forgetSessions: () => {
      sessions.clear();
    },
    close: async () => {
      for (const transport of transports) await transport.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

async function expectNoSseRetriesAfterDisconnect(
  upstream: Awaited<ReturnType<typeof startSessionServer>>,
) {
  vi.useFakeTimers();
  await mcpClient.disconnectAll();
  await upstream.close();
  // Deliver real socket EOF before advancing the SDK's possible retry clock.
  await delay(50);

  const calls: { url: string; body: unknown; stack: string | undefined }[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    calls.push({
      url: String(url),
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
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
