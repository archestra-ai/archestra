import type { IncomingMessage, ServerResponse } from "node:http";
import { RouteId } from "@archestra/shared";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import QuickLRU from "quick-lru";
import { z } from "zod";
import { userHasPermission } from "@/auth/utils";
import type { TokenAuthContext } from "@/clients/mcp-client";
import config from "@/config";
import { AppModel } from "@/models";
import { gateAppToolCall } from "@/services/apps/app-tool-runtime-gate";
import { ApiError, type App, UuidIdSchema } from "@/types";
import {
  APP_LAUNCH_TOOL_NAME,
  createAppServer,
  validateAppGatewayToken,
} from "./mcp-app-gateway.utils";
import {
  createStatelessTransport,
  ensureRequestSocketDestroySoon,
  extractBearerToken,
} from "./mcp-gateway.utils";

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
        body: z.record(z.string(), z.unknown()),
      },
    },
    async (request, reply) => {
      // Ships dark: the endpoint does not exist until the feature is enabled.
      if (!config.apps.enabled) {
        throw new ApiError(404, "Not found");
      }

      const { appId } = request.params as { appId: string };
      const body = request.body as Record<string, unknown>;

      // External MCP clients present a Bearer token (validated here); Archestra's
      // own frontend uses the browser session (request.user, populated upstream).
      const bearer = extractBearerToken(request);
      let userId: string;
      let organizationId: string;
      let tokenAuth: TokenAuthContext;
      // A Bearer connection builds a fresh server per request: AppServerCache is
      // keyed only by (app, user), so reusing across tokens would leak one
      // token's credentials/context into another's calls. The session path keeps
      // the cache (one auth context per browser user).
      let useServerCache: boolean;
      if (bearer) {
        const appAuth = await validateAppGatewayToken(bearer);
        if (!appAuth.ok) {
          throw appAuth.reason === "no_viewer"
            ? new ApiError(
                403,
                "App endpoints require a user-scoped token; organization/team tokens have no viewer.",
              )
            : new ApiError(401, "Unauthorized");
        }
        userId = appAuth.userId;
        organizationId = appAuth.organizationId;
        tokenAuth = {
          tokenId: appAuth.tokenId,
          teamId: null,
          isOrganizationToken: false,
          isUserToken: true,
          userId,
          organizationId,
        };
        useServerCache = false;
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
      }

      // Verify the viewer may view this app (short-lived cache keyed by
      // app+user+org so entries can't leak across orgs).
      const appCacheKey = `${appId}:${userId}:${organizationId}`;
      let app = appAccessCache.get(appCacheKey);
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
        if (app) {
          appAccessCache.set(appCacheKey, app);
        }
      }
      if (!app) {
        throw new ApiError(403, "Forbidden");
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
      try {
        server =
          (useServerCache
            ? appServerCache.acquire(appId, userId)
            : undefined) ?? (await createAppServer(appId, tokenAuth)).server;

        const transport = createStatelessTransport(appId);
        try {
          await server.connect(transport);
        } catch {
          ({ server } = await createAppServer(appId, tokenAuth));
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
          appServerCache.release(appId, userId, server, serverHealthy);
      }
    },
  );
};

// =============================================================================
// Internal helpers
// =============================================================================

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

// Per-(app,user) MCP server cache — reuses McpServer instances across sequential
// requests from the same app session; each request still gets a fresh transport.
class AppServerCache {
  private readonly lru = new QuickLRU<string, AppServerCacheEntry>({
    maxSize: 200,
    maxAge: CACHE_TTL_MS,
  });

  acquire(appId: string, userId: string): McpServer | undefined {
    const entry = this.lru.get(`${appId}:${userId}`);
    if (!entry || entry.inUse) return undefined;
    entry.inUse = true;
    return entry.server;
  }

  release(
    appId: string,
    userId: string,
    server: McpServer,
    healthy: boolean,
  ): void {
    const key = `${appId}:${userId}`;
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
