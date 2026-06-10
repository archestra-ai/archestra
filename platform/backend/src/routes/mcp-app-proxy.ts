import type { IncomingMessage, ServerResponse } from "node:http";
import { MCP_SERVER_TOOL_NAME_SEPARATOR, RouteId } from "@archestra/shared";
import type { McpUiToolMeta } from "@modelcontextprotocol/ext-apps";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import QuickLRU from "quick-lru";
import { z } from "zod";
import { archestraMcpBranding } from "@/archestra-mcp-server";
import { userHasPermission } from "@/auth/utils";
import type { TokenAuthContext } from "@/clients/mcp-client";
import config from "@/config";
import { AppModel, ToolModel } from "@/models";
import { ApiError, type App, UuidIdSchema } from "@/types";
import { APP_DATA_SHORT_NAMES, createAppServer } from "./mcp-app-gateway.utils";
import {
  createStatelessTransport,
  ensureRequestSocketDestroySoon,
} from "./mcp-gateway.utils";

/**
 * App-bound MCP proxy: `POST /api/mcp/app/:appId`. Carries an app's runtime
 * (ui:// HTML read + every tool call) under the browser session, both in chat
 * and on the standalone run page. `appId` is derived from the route — never from
 * the request body — so an app can only ever act as itself.
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
      const userId = request.user.id;
      const { organizationId } = request;

      // Verify the session user may view this app (short-lived cache keyed by
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

      const sessionTokenAuth: TokenAuthContext = {
        tokenId: `session:${userId}`,
        teamId: null,
        isOrganizationToken: false,
        isSessionAuth: true,
        userId,
        organizationId,
      };

      // Gate tools/call on the per-app allowlist + the tool's app visibility.
      // Archestra tools (the App Data Store) are exempt — they are dispatched
      // in-process and authorized by RBAC inside executeArchestraTool.
      if (body.method === "tools/call") {
        const denied = await rejectDisallowedToolCall({
          appId,
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
          appServerCache.acquire(appId, userId) ??
          (await createAppServer(appId, sessionTokenAuth)).server;

        const transport = createStatelessTransport(appId);
        try {
          await server.connect(transport);
        } catch {
          ({ server } = await createAppServer(appId, sessionTokenAuth));
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
        if (server)
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
 * Fail-closed gate for an app's upstream tools/call. Returns a JSON-RPC error
 * body to short-circuit the request, or null to allow it through.
 */
async function rejectDisallowedToolCall(params: {
  appId: string;
  body: Record<string, unknown>;
  reply: StatusReply;
}): Promise<object | null> {
  const { appId, body, reply } = params;
  const toolName =
    body.params &&
    typeof body.params === "object" &&
    "name" in body.params &&
    typeof (body.params as { name: unknown }).name === "string"
      ? (body.params as { name: string }).name
      : undefined;
  if (!toolName) {
    return jsonRpcError(
      reply,
      body.id,
      -32602,
      "Invalid params: tools/call requires a string 'name' parameter",
    );
  }

  // Archestra tools: only the App Data Store tools are dispatchable from an app
  // (authorized by RBAC inside executeArchestraTool). Every other Archestra tool
  // — the management/chat surface — is rejected here, mirroring the server gate.
  if (archestraMcpBranding.isToolName(toolName)) {
    const shortName = archestraMcpBranding.getToolShortName(toolName);
    if (shortName && APP_DATA_SHORT_NAMES.has(shortName)) {
      return null;
    }
    return jsonRpcError(
      reply,
      body.id,
      -32601,
      `Tool "${toolName}" is not available to apps.`,
    );
  }

  // Resolve exactly like dispatch does (clients/mcp-client.ts
  // validateAndGetTool): exact name first, then — for unprefixed names only —
  // the "__<name>" suffix fallback, so a tool reachable at dispatch is never
  // rejected here.
  let [tool] = await ToolModel.getMcpToolsAssignedToApp([toolName], appId);
  if (!tool && !toolName.includes(MCP_SERVER_TOOL_NAME_SEPARATOR)) {
    [tool] = await ToolModel.getMcpToolsAssignedToAppBySuffix(toolName, appId);
  }
  if (!tool) {
    return jsonRpcError(
      reply,
      body.id,
      -32601,
      `Tool "${toolName}" is not assigned to this app.`,
    );
  }
  const visibility = (tool.meta as { _meta?: { ui?: McpUiToolMeta } } | null)
    ?._meta?.ui?.visibility;
  if (visibility && !visibility.includes("app")) {
    return jsonRpcError(
      reply,
      body.id,
      -32601,
      `Tool "${toolName}" is not accessible from MCP Apps (visibility: [${visibility.join(", ")}])`,
    );
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
