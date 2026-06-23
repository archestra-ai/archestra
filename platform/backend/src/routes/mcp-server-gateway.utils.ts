import { MCP_APPS_SERVER_EXTENSION_CAPABILITIES } from "@archestra/shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type ListToolsResult,
  ReadResourceRequestSchema,
  type ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import mcpClient from "@/clients/mcp-client";
import config from "@/config";
import { ToolModel } from "@/models";
import type { McpServerCapabilitiesWithExtensions } from "@/types/mcp-capabilities";
import { normalizeToolInputSchema } from "./mcp-gateway.utils";

type McpListTool = ListToolsResult["tools"][number];

/**
 * Build the server-scoped MCP server backing the Apps run path
 * (`POST /api/mcp/server/:mcpServerId`). It serves one installed external
 * server's runtime — `tools/list` (from discovered tools), `resources/read`
 * (its `ui://` resource), and `tools/call` — all bound to the route's
 * `mcpServerId`, with no agent/owner context. The connection only ever talks to
 * this one installed server, so a `resources/read` can reach only this server's
 * own resources. Access (`mcpServerInstallation:read`) and the
 * `_meta.ui.visibility` model-only gate are enforced by the route before here.
 */
export function createServerScopedServer(params: {
  mcpServerId: string;
  catalogId: string;
}): { server: McpServer } {
  const { mcpServerId, catalogId } = params;
  const mcpServer = new McpServer(
    {
      name: `archestra-mcp-server-${mcpServerId}`,
      version: config.api.version,
    },
    {
      capabilities: {
        resources: { subscribe: false, listChanged: false },
        extensions: { ...MCP_APPS_SERVER_EXTENSION_CAPABILITIES },
        tools: { listChanged: false },
      } as McpServerCapabilitiesWithExtensions,
    },
  );
  const { server } = mcpServer;

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await ToolModel.findByCatalogIdWithMeta(catalogId);
    const listed: McpListTool[] = tools.map((tool) => {
      const meta = tool.meta as {
        annotations?: McpListTool["annotations"];
        _meta?: McpListTool["_meta"];
      } | null;
      return {
        // The connection talks directly to the one upstream server, which uses
        // its own native (raw) tool names. Strip Archestra's discovery prefix so
        // the app's tools/call (raw name) and the upstream agree.
        name: ToolModel.unslugifyName(tool.name),
        description: tool.description ?? undefined,
        inputSchema: normalizeToolInputSchema(tool.parameters),
        annotations: meta?.annotations ?? {},
        _meta: meta?._meta ?? {},
      };
    });
    return { tools: listed };
  });

  server.setRequestHandler(
    ReadResourceRequestSchema,
    async ({ params: { uri } }) =>
      (await mcpClient.readResourceForServer({
        mcpServerId,
        uri,
      })) as ReadResourceResult,
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async ({ params: { name, arguments: args } }) =>
      (await mcpClient.callToolForServer({
        mcpServerId,
        name,
        arguments: args,
      })) as CallToolResult,
  );

  return { server: mcpServer };
}
