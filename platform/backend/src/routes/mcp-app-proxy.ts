import type { IncomingMessage, ServerResponse } from "node:http";
import { RouteId } from "@archestra/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import QuickLRU from "quick-lru";
import { z } from "zod";
import { userHasPermission } from "@/auth/utils";
import type { TokenAuthContext } from "@/clients/mcp-client";
import { AppModel, ConversationModel } from "@/models";
import {
  buildConnectorResourceUri,
  connectorWwwAuthenticate,
} from "@/services/apps/app-connector-resource";
import { gateAppToolCall } from "@/services/apps/app-tool-runtime-gate";
import { ApiError, type App, UuidIdSchema } from "@/types";
import { APP_LAUNCH_TOOL_NAME } from "@/types/app";
import {
  createAppServer,
  validateAppConnectorOAuthToken,
  validateAppGatewayToken,
} from "./mcp-app-gateway.utils";
import {
  createStatelessTransport,
  ensureRequestSocketDestroySoon,
  extractBearerToken,
} from "./mcp-gateway.utils";
import { getPublicRequestOrigin } from "./request-origin";

/**
 * App-bound MCP proxy: `POST /api/mcp/app/:appId`. Carries an app's runtime
 * (ui:// HTML read + every tool call). `appId` is derived from the route — never
 * from the request body — so an app can only ever act as itself.
 *
 * Two callers: Archestra's own frontend (browser session, in chat and on the
 * standalone run page) and external MCP clients (a `Bearer` token, validated
 * in-route — the auth middleware skips its session check for Bearer requests to
 * this path). The Bearer path binds the viewer from the token; both paths bind
 * `appId` from the route, so the per-app isolation invariant holds regardless.
 */
const mcpAppProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.addHook("onClose", () => {
    appAccessCache.clear();
    appServerCache.clear();
  });

  fastify.post(
    "/api/mcp/app/:appId",
    {
      schema: {
        operationId: RouteId.McpAppProxyPost,
        tags: ["mcp-proxy"],
        description: "Proxy an MCP App's runtime requests with session auth",
        params: z.object({ appId: UuidIdSchema }),
        // The embedding chat, set only by Archestra's own trusted host layer
        // when the app renders inside a conversation (it rides outside the
        // app-controlled JSON-RPC body, so the sandboxed iframe can never
        // choose it). Session-auth only; validated below.
        querystring: z.object({ conversationId: UuidIdSchema.optional() }),
        body: z.record(z.string(), z.unknown()),
      },
    },
    async (request, reply) => {
      const { appId } = request.params as { appId: string };
      const { conversationId } = request.query as {
        conversationId?: string;
      };
      const body = request.body as Record<string, unknown>;

      // An external client presents a Bearer token — a personal token or the
      // native OAuth flow's audience-bound token — validated here; Archestra's
      // own frontend uses the browser session (request.user, populated by the
      // auth middleware, which stands down only for the Bearer path). A Bearer
      // connection builds a fresh server per request (the server cache is
      // session-only, so reuse across tokens can't leak context); the session
      // path keeps the cache.
      const bearer = extractBearerToken(request);
      // The auth middleware stands down for ANY `Bearer `-prefixed header —
      // including one with nothing after the scheme, which extractBearerToken
      // (rightly) rejects. Such a request is neither session-authenticated nor
      // token-bearing: challenge it rather than falling through to the session
      // branch, where request.user does not exist.
      if (!bearer && /^Bearer\s+/i.test(request.headers.authorization ?? "")) {
        setConnectorChallenge(request, reply, appId);
        return reply.status(401).send({
          error: { message: "Unauthorized", type: "unauthorized" },
        });
      }
      let userId: string;
      let organizationId: string;
      let tokenAuth: TokenAuthContext;
      let useServerCache: boolean;
      let bypassAccessCache: boolean;
      if (bearer) {
        const auth = await resolveBearerAuth(request, appId, bearer);
        if (!auth.ok) {
          if (auth.kind === "challenge") {
            // No valid token → re-issue the RFC 9728 challenge so the client can
            // (re)discover the authorization server.
            setConnectorChallenge(request, reply, appId);
            return reply.status(401).send({
              error: { message: "Unauthorized", type: "unauthorized" },
            });
          }
          throw new ApiError(403, auth.message);
        }
        // Conversation context is what the trusted frontend host layer passes
        // for a chat-embedded render; an external Bearer client is not that
        // host, so the param is refused rather than silently ignored —
        // fail-closed and honest about why the file tools would see nothing.
        // Checked after token validation so an unauthenticated client still
        // gets the challenge, not a param error.
        if (conversationId) {
          throw new ApiError(
            400,
            "conversationId is only accepted with session authentication",
          );
        }
        userId = auth.userId;
        organizationId = auth.organizationId;
        tokenAuth = auth.tokenAuth;
        useServerCache = false;
        bypassAccessCache = auth.bypassAccessCache;
      } else {
        userId = request.user.id;
        organizationId = request.organizationId;
        tokenAuth = {
          tokenId: `session:${userId}`,
          teamId: null,
          isOrganizationToken: false,
          isSessionAuth: true,
          userId,
          organizationId,
        };
        useServerCache = true;
        bypassAccessCache = false;
      }

      // Verify the viewer may view this app. The OAuth path bypasses the cache so
      // a revoked token or lost view access is denied on the next request; the
      // session and personal-token paths keep the short-lived cache (keyed by
      // app+user+org so entries can't leak across orgs).
      const appCacheKey = `${appId}:${userId}:${organizationId}`;
      let app = bypassAccessCache ? undefined : appAccessCache.get(appCacheKey);
      if (!app) {
        const isAppAdmin = await userHasPermission(
          userId,
          organizationId,
          "app",
          "admin",
        );
        app =
          (await AppModel.findByIdForCaller({
            id: appId,
            organizationId,
            userId,
            isAppAdmin,
          })) ?? undefined;
        if (app && !bypassAccessCache) {
          appAccessCache.set(appCacheKey, app);
        }
      }
      if (!app) {
        throw new ApiError(403, "Forbidden");
      }

      // A chat-embedded render carries its conversation so the assigned file
      // built-ins resolve the chat's file scope. The viewer must be able to
      // open that chat (owner or shared access — the same rule as the chat
      // surface); anything else is a host bug or a forged request and is
      // refused outright, never silently degraded to a no-conversation call.
      if (
        conversationId &&
        !(await ConversationModel.isAccessibleBy({
          id: conversationId,
          userId,
          organizationId,
        }))
      ) {
        throw new ApiError(404, "Conversation not found");
      }

      // Gate tools/call on the per-app allowlist + the tool's app visibility.
      // Archestra tools (the App Data Store) are exempt — they are dispatched
      // in-process and authorized by RBAC inside executeArchestraTool.
      if (body.method === "tools/call") {
        const denied = await rejectDisallowedToolCall({
          appId,
          organizationId,
          userId,
          body,
          reply,
        });
        if (denied) return denied;
      }

      let hijacked = false;
      let server: McpServer | undefined;
      let serverHealthy = false;
      // The server closure captures the conversation context, so the cache key
      // must carry it (and the org): a server built for one chat must never
      // serve another chat's — or a standalone — request within the TTL.
      const serverCacheKey = `${appId}:${userId}:${organizationId}:${conversationId ?? "none"}`;
      try {
        server =
          (useServerCache
            ? appServerCache.acquire(serverCacheKey)
            : undefined) ??
          (await createAppServer({ appId, tokenAuth, conversationId })).server;

        const transport = createStatelessTransport(appId);
        try {
          await server.connect(transport);
        } catch {
          ({ server } = await createAppServer({
            appId,
            tokenAuth,
            conversationId,
          }));
          await server.connect(transport);
        }
        serverHealthy = true;

        reply.hijack();
        hijacked = true;

        ensureRequestSocketDestroySoon(request.raw);
        await transport.handleRequest(
          request.raw as IncomingMessage,
          reply.raw as ServerResponse,
          body,
        );
      } catch (error) {
        fastify.log.error(
          { error, appId },
          "MCP app proxy: error handling request",
        );
        if (!hijacked) {
          throw new ApiError(500, "Internal server error");
        }
        if (!reply.raw.writableEnded) {
          if (!reply.raw.headersSent) {
            reply.raw.writeHead(500, { "Content-Type": "application/json" });
          }
          reply.raw.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal server error" },
              id: null,
            }),
          );
        }
      } finally {
        if (server && useServerCache)
          appServerCache.release(serverCacheKey, server, serverHealthy);
      }
    },
  );
};

// =============================================================================
// Internal helpers
// =============================================================================

type BearerAuth =
  | {
      ok: true;
      userId: string;
      organizationId: string;
      tokenAuth: TokenAuthContext;
      bypassAccessCache: boolean;
    }
  | { ok: false; kind: "challenge" }
  | { ok: false; kind: "forbidden"; message: string };

const NO_VIEWER_MESSAGE =
  "App endpoints require a user-scoped token; organization/team tokens have no viewer.";

/**
 * Resolve a connector Bearer token to its viewer, or signal that the request
 * must be challenged (no valid token) or refused (a token resolving no viewer).
 * The token is tried as a personal token first, then as a native audience-bound
 * OAuth token. The OAuth path bypasses the app-access cache so a revoked token or
 * lost view access is denied on the next request.
 */
async function resolveBearerAuth(
  request: FastifyRequest,
  appId: string,
  bearer: string,
): Promise<BearerAuth> {
  const personal = await validateAppGatewayToken(bearer);
  if (personal.ok) {
    return {
      ok: true,
      userId: personal.userId,
      organizationId: personal.organizationId,
      tokenAuth: userTokenAuthContext(personal),
      bypassAccessCache: false,
    };
  }
  if (personal.reason === "no_viewer") {
    return { ok: false, kind: "forbidden", message: NO_VIEWER_MESSAGE };
  }

  // Not a personal/team token — try the native OAuth token, which must be
  // audience-bound to this connector's own canonical URI.
  const connectorResourceUri = buildConnectorResourceUri(
    getPublicRequestOrigin(request),
    appId,
  );
  if (connectorResourceUri) {
    const oauth = await validateAppConnectorOAuthToken({
      token: bearer,
      appId,
      connectorResourceUri,
    });
    if (oauth.ok) {
      return {
        ok: true,
        userId: oauth.userId,
        organizationId: oauth.organizationId,
        tokenAuth: userTokenAuthContext(oauth),
        bypassAccessCache: true,
      };
    }
    if (oauth.reason === "no_viewer") {
      return { ok: false, kind: "forbidden", message: NO_VIEWER_MESSAGE };
    }
  }
  return { ok: false, kind: "challenge" };
}

function userTokenAuthContext(auth: {
  tokenId: string;
  userId: string;
  organizationId: string;
}): TokenAuthContext {
  return {
    tokenId: auth.tokenId,
    teamId: null,
    isOrganizationToken: false,
    isUserToken: true,
    userId: auth.userId,
    organizationId: auth.organizationId,
  };
}

/**
 * Attach the RFC 9728 `WWW-Authenticate` challenge pointing at this connector's
 * protected-resource metadata, so a client discovers the authorization server
 * and the scope to request.
 */
function setConnectorChallenge(
  request: FastifyRequest,
  reply: FastifyReply,
  appId: string,
): void {
  reply.header(
    "WWW-Authenticate",
    connectorWwwAuthenticate(getPublicRequestOrigin(request), appId),
  );
}

/** Minimal reply surface the JSON-RPC gate needs — set the HTTP status to 200. */
interface StatusReply {
  status: (code: number) => unknown;
}

function jsonRpcError(
  reply: StatusReply,
  id: unknown,
  code: number,
  message: string,
) {
  reply.status(200);
  return { jsonrpc: "2.0", error: { code, message }, id: id ?? null };
}

/**
 * Fail-closed gate for an app's tools/call. Delegates to the shared runtime gate
 * (assignment allowlist + visibility + invocation policy) so the proxy and
 * preview_app_tool can never diverge. Returns a JSON-RPC error body to
 * short-circuit the request, or null to allow it through.
 */
async function rejectDisallowedToolCall(params: {
  appId: string;
  organizationId: string;
  userId: string;
  body: Record<string, unknown>;
  reply: StatusReply;
}): Promise<object | null> {
  const { appId, organizationId, userId, body, reply } = params;
  const callParams =
    body.params && typeof body.params === "object"
      ? (body.params as { name?: unknown; arguments?: unknown })
      : undefined;
  const toolName =
    typeof callParams?.name === "string" ? callParams.name : undefined;
  if (!toolName) {
    return jsonRpcError(
      reply,
      body.id,
      -32602,
      "Invalid params: tools/call requires a string 'name' parameter",
    );
  }
  // The synthetic launch tool only hands back the app's own UI resource URI; it
  // reaches no upstream tool or data store, so it bypasses the assignment gate
  // (which would otherwise reject it as "not assigned to this app").
  if (toolName === APP_LAUNCH_TOOL_NAME) {
    return null;
  }
  const toolInput =
    callParams?.arguments && typeof callParams.arguments === "object"
      ? (callParams.arguments as Record<string, unknown>)
      : {};

  // The app runtime is treated as trusted for policy purposes: only an explicit
  // block_always/require_approval gates it, so a no-policy assigned tool keeps
  // working as before. No approval UI exists inside the sandbox, so a
  // require_approval policy blocks at runtime (an authoring agent can still
  // exercise it through preview_app_tool, which carries its own approval gate).
  const decision = await gateAppToolCall({
    appId,
    organizationId,
    userId,
    toolName,
    toolInput,
    isContextTrusted: true,
    treatRequireApprovalAsBlock: true,
  });
  if (!decision.allowed) {
    return jsonRpcError(reply, body.id, decision.code, decision.reason);
  }
  // Dispatch the exact tool the gate resolved (and evaluated policy on), so a
  // suffix-addressed name can't re-resolve to a different row at execution.
  if (decision.kind === "upstream" && callParams) {
    callParams.name = decision.resolvedToolName;
  }
  return null;
}

const CACHE_TTL_MS = 30_000;

// Per-user app access cache — only successful lookups are cached; a revoked
// access keeps passing until the entry ages out (within CACHE_TTL_MS).
const appAccessCache = new QuickLRU<string, App>({
  maxSize: 500,
  maxAge: CACHE_TTL_MS,
});

type AppServerCacheEntry = { server: McpServer; inUse: boolean };

// Per-(app,user,org,conversation) MCP server cache — reuses McpServer instances
// across sequential requests from the same app session; each request still gets
// a fresh transport. The key is built by the route and includes the validated
// conversation context (or a "none" sentinel) because the server closure
// captures it — a cached server must only ever serve requests with the exact
// same scope.
class AppServerCache {
  private readonly lru = new QuickLRU<string, AppServerCacheEntry>({
    maxSize: 200,
    maxAge: CACHE_TTL_MS,
  });

  acquire(key: string): McpServer | undefined {
    const entry = this.lru.get(key);
    if (!entry || entry.inUse) return undefined;
    entry.inUse = true;
    return entry.server;
  }

  release(key: string, server: McpServer, healthy: boolean): void {
    const entry = this.lru.get(key);
    if (entry && entry.server === server) {
      if (healthy) {
        entry.inUse = false;
      } else {
        this.lru.delete(key);
      }
    } else if (!entry && healthy) {
      this.lru.set(key, { server, inUse: false });
    }
  }

  clear(): void {
    this.lru.clear();
  }
}

const appServerCache = new AppServerCache();

export default mcpAppProxyRoutes;
