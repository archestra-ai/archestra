import { MCP_APPS_SERVER_EXTENSION_CAPABILITIES } from "@archestra/shared";
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
  UserModel,
} from "@/models";
import {
  type AppSdkTool,
  injectAppSdk,
} from "@/services/apps/app-sdk-injection";
import { APP_RUNTIME_BUILTIN_SHORT_NAMES } from "@/services/apps/app-tool-runtime-gate";
import { APP_PLATFORM_CSP } from "@/services/apps/app-ui-policy";
import type { CommonToolCall } from "@/types";
import { appOwner } from "@/types";
import type { App } from "@/types/app";
import type { McpServerCapabilitiesWithExtensions } from "@/types/mcp-capabilities";
import {
  deriveAuthMethod,
  normalizeToolInputSchema,
} from "./mcp-gateway.utils";

type McpListTool = ListToolsResult["tools"][number];

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
    const tools = await buildPermittedAppToolList(appId, tokenAuth);

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
      const viewer = tokenAuth.userId
        ? await UserModel.getById(tokenAuth.userId)
        : null;
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_TYPE,
            // Owned apps get the Apps SDK (window.archestra) injected at serve
            // time; the stored HTML stays pure UI. The bootstrap carries the
            // viewer identity and the assigned-tool descriptors.
            text: await injectAppSdk(head.html, {
              user: viewer ? { id: viewer.id, name: viewer.name } : null,
              tools: await buildAppSdkTools(appId, tokenAuth),
              appId,
              version: head.version,
              captureScreenshot:
                viewer != null && current?.authorId === viewer.id,
            }),
            _meta: {
              ui: {
                // Owned apps always render under the platform CSP — never a
                // stored, author-influenced one. MCP tools are the only data
                // egress; static assets come from the hardcoded CDN allowlist.
                csp: APP_PLATFORM_CSP,
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
      // Reserved app-runtime built-ins (App Data Store + the LLM completion)
      // run in-process with the route-bound appId so they can only ever act for
      // this app. Other Archestra tools (the management/chat surface) are NOT
      // dispatchable from an app runtime.
      if (archestraMcpBranding.isToolName(name)) {
        const shortName = archestraMcpBranding.getToolShortName(name);
        if (!shortName || !APP_RUNTIME_BUILTIN_SHORT_NAMES.has(shortName)) {
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

/**
 * The app endpoint's tool list (assigned upstream tools + the App Data Store
 * built-ins), RBAC-filtered for the viewing user. Shared by the MCP
 * tools/list handler and the SDK bootstrap.
 */
async function buildPermittedAppToolList(
  appId: string,
  tokenAuth: TokenAuthContext,
): Promise<McpListTool[]> {
  const candidates = await buildAppToolList(appId);
  const permittedNames = await filterToolNamesByPermission(
    candidates.map((t) => t.name),
    tokenAuth.userId,
    tokenAuth.organizationId,
  );
  return candidates.filter((t) => permittedNames.has(t.name));
}

/**
 * The assigned-tool descriptors embedded into the SDK bootstrap for
 * `archestra.tools.list()`: only tools the app's HTML can actually call —
 * RBAC-permitted upstream tools that don't exclude the "app" surface via
 * `_meta.ui.visibility`. The App Data Store built-ins are deliberately absent
 * (apps reach them through `archestra.storage`, not `tools.call`).
 */
async function buildAppSdkTools(
  appId: string,
  tokenAuth: TokenAuthContext,
): Promise<AppSdkTool[]> {
  const permitted = await buildPermittedAppToolList(appId, tokenAuth);
  return permitted
    .filter((tool) => !archestraMcpBranding.isToolName(tool.name))
    .filter((tool) => {
      const visibility = (
        tool._meta as { ui?: { visibility?: string[] } } | undefined
      )?.ui?.visibility;
      return !visibility || visibility.includes("app");
    })
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? null,
      inputSchema: tool.inputSchema,
    }));
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

  const builtInTools = getArchestraMcpTools().filter((tool) => {
    const shortName = archestraMcpBranding.getToolShortName(tool.name);
    return shortName !== null && APP_RUNTIME_BUILTIN_SHORT_NAMES.has(shortName);
  });

  return [...upstreamTools, ...builtInTools];
}
