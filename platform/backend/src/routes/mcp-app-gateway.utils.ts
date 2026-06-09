import {
  MCP_APPS_SERVER_EXTENSION_CAPABILITIES,
  TOOL_APP_DATA_DELETE_SHORT_NAME,
  TOOL_APP_DATA_GET_SHORT_NAME,
  TOOL_APP_DATA_LIST_SHORT_NAME,
  TOOL_APP_DATA_SET_SHORT_NAME,
} from "@archestra/shared";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type ListToolsResult,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  archestraMcpBranding,
  executeArchestraTool,
  filterToolNamesByPermission,
  getArchestraMcpTools,
} from "@/archestra-mcp-server";
import mcpClient, { type TokenAuthContext } from "@/clients/mcp-client";
import config from "@/config";
import logger from "@/logging";
import {
  AppModel,
  AppToolModel,
  AppVersionModel,
  McpToolCallModel,
} from "@/models";
import type { CommonToolCall } from "@/types";
import { appOwner } from "@/types";
import type { App } from "@/types/app";
import type { McpServerCapabilitiesWithExtensions } from "@/types/mcp-capabilities";
import {
  deriveAuthMethod,
  normalizeToolInputSchema,
} from "./mcp-gateway.utils";

type McpListTool = ListToolsResult["tools"][number];

// The App Data Store tools are exposed to a running app alongside its assigned
// upstream tools; the management tools (create_app, …) are a chat surface and
// are the ONLY Archestra tools an app runtime may dispatch. This set is the
// authoritative allowlist for the Archestra branch of tools/call — without it,
// an app (whose context has no agentId, so the agent-assignment check is
// skipped) could call any Archestra tool the session user has RBAC for.
export const APP_DATA_SHORT_NAMES = new Set<string>([
  TOOL_APP_DATA_GET_SHORT_NAME,
  TOOL_APP_DATA_SET_SHORT_NAME,
  TOOL_APP_DATA_LIST_SHORT_NAME,
  TOOL_APP_DATA_DELETE_SHORT_NAME,
]);

/**
 * Build the app-bound MCP server: a single endpoint carrying an app's whole
 * runtime. It serves the app's head-version HTML as a `ui://` resource and
 * dispatches tools/call to either the App Data Store tools (via
 * `executeArchestraTool`, with `appId` bound from the route) or the app's
 * assigned upstream tools (via {@link mcpClient.executeToolCallForOwner} as the
 * app owner — which fail-closes to the per-app allowlist and records the call
 * against the app on the audit row).
 */
export async function createAppServer(
  appId: string,
  tokenAuth: TokenAuthContext,
): Promise<{ server: McpServer; app: App }> {
  const mcpServer = new McpServer(
    {
      name: `archestra-app-${appId}`,
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

  const app = await AppModel.findById(appId);
  if (!app) throw new Error(`App not found: ${appId}`);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const candidates = await buildAppToolList(appId);
    const permittedNames = await filterToolNamesByPermission(
      candidates.map((t) => t.name),
      tokenAuth.userId,
      tokenAuth.organizationId,
    );
    const tools = candidates.filter((t) => permittedNames.has(t.name));

    try {
      await McpToolCallModel.create({
        ownerType: "app",
        appId,
        agentId: null,
        mcpServerName: "mcp-app-gateway",
        method: "tools/list",
        toolCall: null,
        // biome-ignore lint/suspicious/noExplicitAny: toolResult shape varies by method
        toolResult: { tools } as any,
        userId: tokenAuth.userId ?? null,
        authMethod: deriveAuthMethod(tokenAuth) ?? null,
      });
    } catch (dbError) {
      logger.warn({ err: dbError, appId }, "Failed to persist app tools/list");
    }

    return { tools };
  });

  // Serve the app's head-version HTML (+ its CSP/permissions envelope) as the
  // UI resource. The head is read fresh so an edit mid-session is picked up.
  server.setRequestHandler(
    ReadResourceRequestSchema,
    async ({ params: { uri } }) => {
      const current = await AppModel.findById(appId);
      const head = current
        ? await AppVersionModel.findByAppAndVersion(
            appId,
            current.latestVersion,
          )
        : null;
      if (!head) {
        throw {
          code: -32002,
          message: `App resource not found for ${appId}`,
        };
      }
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_TYPE,
            text: head.html,
            _meta: {
              ui: {
                ...(head.uiCsp ? { csp: head.uiCsp } : {}),
                ...(head.uiPermissions
                  ? { permissions: head.uiPermissions }
                  : {}),
              },
            },
          },
        ],
      };
    },
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async ({ params: { name, arguments: args } }) => {
      // App Data Store tools run in-process with the route-bound appId so they
      // can only ever touch this app's own store. Other Archestra tools (the
      // management/chat surface) are NOT dispatchable from an app runtime.
      if (archestraMcpBranding.isToolName(name)) {
        const shortName = archestraMcpBranding.getToolShortName(name);
        if (!shortName || !APP_DATA_SHORT_NAMES.has(shortName)) {
          throw {
            code: -32601,
            message: `Tool "${name}" is not available to apps.`,
          };
        }
        const response = await executeArchestraTool(name, args, {
          agent: { id: appId, name: app.name },
          appId,
          userId: tokenAuth.userId,
          organizationId: tokenAuth.organizationId,
          tokenAuth,
        });
        try {
          await McpToolCallModel.create({
            ownerType: "app",
            appId,
            agentId: null,
            mcpServerName: archestraMcpBranding.serverName,
            method: "tools/call",
            toolCall: { id: `app-${Date.now()}`, name, arguments: args || {} },
            toolResult: response,
            userId: tokenAuth.userId ?? null,
            authMethod: deriveAuthMethod(tokenAuth) ?? null,
          });
        } catch (dbError) {
          logger.warn(
            { err: dbError, appId, toolName: name },
            "Failed to persist app archestra tool call",
          );
        }
        return response;
      }

      const toolCall: CommonToolCall = {
        id: `app-call-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        name,
        arguments: args || {},
      };
      // executeToolCallForOwner already persists the audit row (ownerType=app).
      const result = await mcpClient.executeToolCallForOwner(
        toolCall,
        appOwner(appId),
        tokenAuth,
      );
      return {
        content: Array.isArray(result.content)
          ? result.content
          : [{ type: "text", text: JSON.stringify(result.content) }],
        isError: result.isError,
        _meta: result._meta,
        structuredContent: result.structuredContent,
      };
    },
  );

  logger.info({ appId }, "MCP app server instance created");
  return { server: mcpServer, app };
}

async function buildAppToolList(appId: string): Promise<McpListTool[]> {
  const upstream = await AppToolModel.getToolsForApp(appId);
  const upstreamTools: McpListTool[] = upstream.map((tool) => {
    const meta = tool.meta as {
      annotations?: McpListTool["annotations"];
      _meta?: McpListTool["_meta"];
    } | null;
    return {
      name: tool.name,
      title: tool.name,
      description: tool.description ?? undefined,
      inputSchema: normalizeToolInputSchema(tool.parameters),
      annotations: meta?.annotations ?? {},
      _meta: meta?._meta ?? {},
    };
  });

  const appDataTools = getArchestraMcpTools().filter((tool) => {
    const shortName = archestraMcpBranding.getToolShortName(tool.name);
    return shortName !== null && APP_DATA_SHORT_NAMES.has(shortName);
  });

  return [...upstreamTools, ...appDataTools];
}
