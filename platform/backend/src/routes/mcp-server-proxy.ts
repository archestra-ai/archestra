import type { IncomingMessage, ServerResponse } from "node:http";
import { RouteId } from "@archestra/shared";
import type { McpServer as McpServerInstance } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import QuickLRU from "quick-lru";
import { z } from "zod";
import { userHasPermission } from "@/auth/utils";
import { McpServerModel, ToolModel } from "@/models";
import { enforceAppRuntimeInvocationPolicy } from "@/services/apps/app-tool-runtime-gate";
import { ApiError, type McpServer, UuidIdSchema } from "@/types";
import {
  createStatelessTransport,
  ensureRequestSocketDestroySoon,
} from "./mcp-gateway.utils";
import { createServerScopedServer } from "./mcp-server-gateway.utils";

/**
 * Server-scoped MCP proxy: `POST /api/mcp/server/:mcpServerId`. Serves an
 * installed external server's MCP App runtime (its `ui://` resource + tool
 * calls) from the Apps page, with no agent context. `mcpServerId` is bound from
 * the route. Session-authenticated; the per-server access check is the
 * authorization gate (the caller must be able to view this install). Tool calls
 * run with the install's own credentials (see `mcp-client.callToolForServer`).
 */
const mcpServerProxyRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.addHook("onClose", () => {
    serverAccessCache.clear();
  });

  fastify.post(
    "/api/mcp/server/:mcpServerId",
    {
      schema: {
        operationId: RouteId.McpServerProxyPost,
        tags: ["mcp-proxy"],
        description:
          "Proxy a server-scoped MCP App's runtime requests with session auth",
        params: z.object({ mcpServerId: UuidIdSchema }),
        body: z.record(z.string(), z.unknown()),
      },
    },
    async (request, reply) => {
      const { mcpServerId } = request.params as { mcpServerId: string };
      const body = request.body as Record<string, unknown>;
      const userId = request.user.id;
      const { organizationId } = request;

      // Authorization: the caller must be able to view this installed server
      // (team/personal/org). McpServerModel.findById applies that access filter
      // and returns null otherwise. Cached briefly; the key includes the org so
      // entries can't leak across orgs.
      const cacheKey = `${mcpServerId}:${userId}:${organizationId}`;
      let server = serverAccessCache.get(cacheKey);
      if (!server) {
        const isMcpServerAdmin = await userHasPermission(
          userId,
          organizationId,
          "mcpServerInstallation",
          "admin",
        );
        server =
          (await McpServerModel.findById(
            mcpServerId,
            userId,
            isMcpServerAdmin,
          )) ?? undefined;
        if (server) serverAccessCache.set(cacheKey, server);
      }
      if (!server || !server.catalogId) {
        throw new ApiError(403, "Forbidden");
      }
      const { catalogId } = server;

      // Gate tools/call on _meta.ui.visibility: model-only tools are not
      // app-callable. Fail-closed on unknown tools. Mirrors the agent proxy.
      if (body.method === "tools/call") {
        const denied = await rejectDisallowedToolCall(
          catalogId,
          body,
          reply,
          userId,
          organizationId,
        );
        if (denied) return denied;
      }

      let hijacked = false;
      let mcp: McpServerInstance | undefined;
      try {
        ({ server: mcp } = createServerScopedServer({
          mcpServerId,
          catalogId,
        }));
        const transport = createStatelessTransport(mcpServerId);
        await mcp.connect(transport);

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
          { error, mcpServerId },
          "MCP server proxy: error handling request",
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
      }
    },
  );
};

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
 * Fail-closed gate for a server-scoped tools/call: reject an unknown tool, and
 * reject a tool whose `_meta.ui.visibility` excludes "app" (model-only). Returns
 * a JSON-RPC error body to short-circuit, or null to allow.
 */
async function rejectDisallowedToolCall(
  catalogId: string,
  body: Record<string, unknown>,
  reply: StatusReply,
  userId: string,
  organizationId: string,
): Promise<object | null> {
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
  const tools = await ToolModel.findByCatalogIdWithMeta(catalogId);
  // The app calls by the upstream's raw tool name; the DB stores the slugified
  // (prefixed) name. Match on the unslugified name (fall back to exact).
  const tool = tools.find(
    (candidate) =>
      ToolModel.unslugifyName(candidate.name) === toolName ||
      candidate.name === toolName,
  );
  if (!tool) {
    return jsonRpcError(
      reply,
      body.id,
      -32601,
      `No tool named "${toolName}" is available here. Call tools/list to see the available tools and use an exact name from it.`,
    );
  }
  const visibility = (
    tool.meta as { _meta?: { ui?: { visibility?: string[] } } } | null
  )?._meta?.ui?.visibility;
  if (visibility && !visibility.includes("app")) {
    return jsonRpcError(
      reply,
      body.id,
      -32601,
      `Tool "${toolName}" is not accessible from MCP Apps (visibility: [${visibility.join(", ")}])`,
    );
  }

  // This runtime dispatches to the upstream with the install's own credentials
  // and otherwise never touches the policy engine, so tool-invocation policies
  // must be enforced here — mirroring the owned-app runtime (gateAppToolCall).
  // The app sandbox is a trusted, no-approval-UI context, so
  // block_always/require_approval gate the call while a no-policy tool stays
  // callable. Policy is keyed by the stored (slugified) name.
  const refusal = await enforceAppRuntimeInvocationPolicy({
    resolvedToolName: tool.name,
    displayName: toolName,
    toolInput:
      callParams?.arguments && typeof callParams.arguments === "object"
        ? (callParams.arguments as Record<string, unknown>)
        : {},
    organizationId,
    userId,
    isContextTrusted: true,
    treatRequireApprovalAsBlock: true,
  });
  if (refusal) {
    return jsonRpcError(reply, body.id, refusal.code, refusal.reason);
  }

  return null;
}

const serverAccessCache = new QuickLRU<string, McpServer>({
  maxSize: 500,
  maxAge: 30_000,
});

export default mcpServerProxyRoutes;
