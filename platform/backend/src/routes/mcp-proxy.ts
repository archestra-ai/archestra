import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpUiToolMeta } from "@modelcontextprotocol/ext-apps";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RouteId } from "@shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import QuickLRU from "quick-lru";
import { z } from "zod";
import { hasAnyAgentTypeAdminPermission } from "@/auth";
import type { TokenAuthContext } from "@/clients/mcp-client";
import { AgentModel, ToolModel } from "@/models";
import { type Agent, ApiError, UuidIdSchema } from "@/types";
import {
  createAgentServer,
  createStatelessTransport,
} from "./mcp-gateway.utils";

/**
 * MCP Proxy routes for frontend AppRenderer
 * Provides session-based auth access to MCP Gateway endpoints
 */
export const mcpProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Clear caches on server shutdown to release held MCP connections
  fastify.addHook("onClose", () => {
    agentAccessCache.clear();
    mcpServerCache.clear();
  });

  // POST endpoint to proxy JSON-RPC requests from frontend to MCP Gateway
  fastify.post(
    "/api/mcp/:agentId",
    {
      schema: {
        operationId: RouteId.McpProxyPost,
        tags: ["mcp-proxy"],
        description: "Proxy MCP Gateway requests with session auth",
        params: z.object({
          agentId: UuidIdSchema,
        }),
        body: z.record(z.string(), z.unknown()),
      },
    },
    async (request, reply) => {
      const { agentId } = request.params as { agentId: string };
      const body = request.body as Record<string, unknown>;
      const userId = request.user.id;
      const { organizationId } = request;
      const cacheKey = getScopedCacheKey(agentId, userId, organizationId);

      fastify.log.info(
        { agentId, method: body.method, userId },
        "MCP proxy: handling frontend MCP Apps request",
      );

      // Verify user has access to the requested agent, using a short-lived
      // cache to avoid repeated DB round-trips within the same MCP App session.
      let agent = agentAccessCache.get(cacheKey);
      if (!agent) {
        const isAgentAdmin = await hasAnyAgentTypeAdminPermission({
          userId,
          organizationId,
        });
        agent =
          (await AgentModel.findById(agentId, userId, isAgentAdmin)) ??
          undefined;
      }
      if (!agent || agent.organizationId !== organizationId) {
        throw new ApiError(403, "Forbidden");
      }
      agentAccessCache.set(cacheKey, agent);

      // Build a session-scoped TokenAuthContext so audit logs, user context, and
      // organisation-scoped Archestra tools all work the same as token auth.
      const sessionTokenAuth: TokenAuthContext = {
        tokenId: `session:${userId}`,
        teamId: null,
        isOrganizationToken: false,
        isSessionAuth: true,
        userId,
        organizationId,
      };

      // Enforce ui/visibility for tools/call: reject requests from MCP App iframes
      // for tools that don't include "app" in their _meta.ui.visibility.
      // Tools with visibility: ["model"] are model-only and must not be callable by apps.
      // Note: tools/list intentionally returns all tools (discovery is not a security
      // concern) — only execution is gated here.
      if (body.method === "tools/call") {
        const toolName = (body.params as { name?: string } | undefined)?.name;
        if (toolName) {
          const tool = await ToolModel.findByName(toolName);
          if (tool) {
            const toolMeta = tool.meta as
              | { _meta?: { ui?: McpUiToolMeta } }
              | undefined;
            const visibility = toolMeta?._meta?.ui?.visibility;
            if (visibility && !visibility.includes("app")) {
              fastify.log.warn(
                { agentId, toolName, visibility },
                "MCP proxy: rejecting tools/call for app-invisible tool",
              );
              reply.status(200);
              return {
                jsonrpc: "2.0",
                error: {
                  code: -32601,
                  message: `Tool "${toolName}" is not accessible from MCP Apps (visibility: [${visibility.join(", ")}])`,
                },
                id: body.id ?? null,
              };
            }
          }
        }
      }

      let hijacked = false;
      let server: McpServer | undefined;
      try {
        const cachedServer = mcpServerCache.acquire(
          agentId,
          userId,
          organizationId,
        );
        if (cachedServer) {
          server = cachedServer;
        } else {
          ({ server } = await createAgentServer(agentId, sessionTokenAuth, {
            id: agent.id,
            name: agent.name,
            agentType: agent.agentType,
            labels: agent.labels,
          }));
        }

        const transport = createStatelessTransport(agentId);
        try {
          await server.connect(transport);
        } catch {
          // Server still bound to previous transport (rare concurrent request);
          // replace it with a fresh one.
          ({ server } = await createAgentServer(agentId, sessionTokenAuth, {
            id: agent.id,
            name: agent.name,
            agentType: agent.agentType,
            labels: agent.labels,
          }));
          await server.connect(transport);
        }

        // Hijack reply to let SDK handle raw response
        reply.hijack();
        hijacked = true;

        await transport.handleRequest(
          request.raw as IncomingMessage,
          reply.raw as ServerResponse,
          body,
        );

        fastify.log.info({ agentId }, "MCP proxy: request completed");
      } catch (error) {
        fastify.log.error(
          { error, agentId },
          "MCP proxy: error handling request",
        );

        if (!hijacked) {
          reply.status(500);
          return {
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal server error",
            },
            id: null,
          };
        }

        // After hijack Fastify relinquishes control — write error to raw response
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
        if (server) {
          mcpServerCache.release(agentId, userId, organizationId, server);
        }
      }
    },
  );
};

// =============================================================================
// Internal helpers
// =============================================================================

const CACHE_TTL_MS = 30_000; // 30 seconds

// Per-user agent access cache — avoids repeated DB queries for the same
// (agentId, userId) pair within a session. Only successful lookups are cached
// so revocations take effect on the next request.
const agentAccessCache = new QuickLRU<string, Agent>({
  maxSize: 500,
  maxAge: CACHE_TTL_MS,
});

type McpServerCacheEntry = { server: McpServer; inUse: boolean };

// Per-user MCP server cache — reuses McpServer instances (registered handlers,
// config) across sequential requests from the same MCP App session. Each
// request still gets a fresh StatelessTransport. A server marked inUse is
// skipped for concurrent requests; the caller creates a fresh one instead.
class McpServerCache {
  private readonly lru = new QuickLRU<string, McpServerCacheEntry>({
    maxSize: 200,
    maxAge: CACHE_TTL_MS,
  });

  /** Try to acquire a cached server. Returns undefined if none available or busy. */
  acquire(
    agentId: string,
    userId: string,
    organizationId: string,
  ): McpServer | undefined {
    const key = getScopedCacheKey(agentId, userId, organizationId);
    const entry = this.lru.get(key);
    if (!entry || entry.inUse) return undefined;
    entry.inUse = true;
    return entry.server;
  }

  /** Release a server back into the cache for future reuse. */
  release(
    agentId: string,
    userId: string,
    organizationId: string,
    server: McpServer,
  ): void {
    const key = getScopedCacheKey(agentId, userId, organizationId);
    const entry = this.lru.get(key);
    // Only release back if we still own the cache slot (no concurrent overwrite)
    if (entry && entry.server === server) {
      entry.inUse = false;
    } else {
      // First time or the entry was replaced — store as available
      this.lru.set(key, { server, inUse: false });
    }
  }

  clear(): void {
    this.lru.clear();
  }
}

function getScopedCacheKey(
  agentId: string,
  userId: string,
  organizationId: string,
): string {
  return `${organizationId}:${agentId}:${userId}`;
}

const mcpServerCache = new McpServerCache();
