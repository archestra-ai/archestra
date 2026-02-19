import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission, userHasPermission } from "@/auth";
import mcpClient, { type TokenAuthContext } from "@/clients/mcp-client";
import config from "@/config";
import logger from "@/logging";
import {
  AgentModel,
  InternalMcpCatalogModel,
  McpServerModel,
  ToolModel,
} from "@/models";
import {
  ApiError,
  constructResponseSchema,
  ErrorResponsesSchema,
  UuidIdSchema,
  type CommonMcpToolDefinitionWithApps,
} from "@/types";

// =============================================================================
// MCP Apps Gateway - 支持 MCP Apps 协议
// 提供 UI 资源发现和获取功能
// =============================================================================

/**
 * 从 URI 解析 server name 和 resource path
 * URI 格式: ui://server-name/resource-path
 */
function parseUIUri(uri: string): { serverName: string; resourcePath: string } | null {
  const match = uri.match(/^ui:\/\/([^\/]+)\/(.+)$/);
  if (!match) {
    return null;
  }
  return {
    serverName: match[1],
    resourcePath: match[2],
  };
}

/**
 * 根据 server name 查找 MCP catalog 和 server
 */
async function resolveServerByName(
  serverName: string,
  agentId: string,
  userId?: string,
): Promise<{
  catalogItem: NonNullable<Awaited<ReturnType<typeof InternalMcpCatalogModel.findById>>>;
  targetMcpServerId: string;
} | null> {
  // 获取 agent 的所有工具
  const mcpTools = await ToolModel.getMcpToolsByAgent(agentId);
  
  // 查找匹配 server name 的工具
  for (const tool of mcpTools) {
    if (!tool.catalogId) continue;
    
    const catalogItem = await InternalMcpCatalogModel.findById(tool.catalogId);
    if (!catalogItem) continue;
    
    // 检查 catalog name 是否匹配 server name
    if (catalogItem.name !== serverName) continue;
    
    // 获取 MCP server
    const servers = await McpServerModel.findByCatalogId(tool.catalogId);
    if (servers.length === 0) continue;
    
    // 优先使用用户自己的 server
    const userServer = userId 
      ? servers.find(s => s.ownerId === userId && !s.teamId)
      : undefined;
    
    const targetServer = userServer || servers[0];
    
    return {
      catalogItem,
      targetMcpServerId: targetServer.id,
    };
  }
  
  return null;
}

/**
 * MCP Apps 路由
 * 提供:
 * 1. GET /api/mcp-apps/tools - 列出支持 MCP Apps 的工具
 * 2. GET /api/mcp-apps/resources/:uri - 获取 UI 资源
 * 3. POST /api/mcp-apps/tools/:toolName/call - 调用工具并返回 MCP App 结果
 */
export const mcpAppsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const basePath = "/api/mcp-apps";

  // ===========================================================================
  // GET /api/mcp-apps/tools - 列出支持 MCP Apps 的工具
  // ===========================================================================
  fastify.get(
    `${basePath}/tools`,
    {
      schema: {
        tags: ["mcp-apps"],
        summary: "List MCP Apps enabled tools",
        description: "获取支持 MCP Apps 的工具列表及其 UI 元数据",
        querystring: z.object({
          agentId: UuidIdSchema,
        }),
        response: {
          200: constructResponseSchema(
            z.array(
              z.object({
                name: z.string(),
                description: z.string().nullable(),
                inputSchema: z.record(z.string(), z.unknown()),
                resourceUri: z.string(),
                permissions: z.array(z.string()).optional(),
                csp: z.record(z.string(), z.array(z.string())).optional(),
              }),
            ),
          ),
          ...ErrorResponsesSchema,
        },
      },
    },
    async (request, reply) => {
      const { user, organizationId, headers } = request;
      const { agentId } = request.query as { agentId: string };

      // 检查权限
      const hasAccess = await userHasPermission(
        user.id,
        organizationId,
        "profile",
        "read",
      );
      if (!hasAccess) {
        throw new ApiError(403, "No permission to access this agent");
      }

      // 验证 agent 存在
      const agent = await AgentModel.findById(agentId);
      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      // 获取支持 MCP Apps 的工具
      const tools = await ToolModel.getMcpToolsByAgent(agentId);
      const appsTools: Array<{
        name: string;
        description: string | null;
        inputSchema: Record<string, unknown>;
        resourceUri: string;
        permissions?: string[];
        csp?: Record<string, string[]>;
      }> = [];

      for (const tool of tools) {
        // 检查工具是否有 _meta.ui 配置
        // 这里需要从原始 MCP server 获取工具定义
        if (!tool.catalogId) continue;

        const catalogItem = await InternalMcpCatalogModel.findById(tool.catalogId);
        if (!catalogItem) continue;

        // 获取工具定义（包含 _meta）
        try {
          const servers = await McpServerModel.findByCatalogId(tool.catalogId);
          if (servers.length === 0) continue;

          const userServer = user.id
            ? servers.find((s) => s.ownerId === user.id && !s.teamId)
            : undefined;
          const targetServer = userServer || servers[0];

          // 获取工具定义
          const toolDefinitions = await mcpClient.connectAndGetTools({
            catalogItem,
            mcpServerId: targetServer.id,
            secrets: {},
          });

          // 查找当前工具的定义
          const toolDef = toolDefinitions.find(
            (t: CommonMcpToolDefinitionWithApps) => {
              // 工具名可能包含 server prefix，需要匹配
              const toolNameWithoutPrefix = t.name.includes("__")
                ? t.name.split("__").pop() || t.name
                : t.name;
              const targetToolNameWithoutPrefix = tool.name.includes("__")
                ? tool.name.split("__").pop() || tool.name
                : tool.name;
              return toolNameWithoutPrefix === targetToolNameWithoutPrefix;
            },
          );

          if (toolDef?._meta?.ui?.resourceUri) {
            appsTools.push({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.parameters as Record<string, unknown>,
              resourceUri: toolDef._meta.ui.resourceUri,
              permissions: toolDef._meta.ui.permissions,
              csp: toolDef._meta.ui.csp,
            });
          }
        } catch (error) {
          logger.warn(
            { toolName: tool.name, error },
            "Failed to get tool definition for MCP Apps",
          );
        }
      }

      return {
        data: appsTools,
      };
    },
  );

  // ===========================================================================
  // GET /api/mcp-apps/resources/:uri - 获取 UI 资源
  // ===========================================================================
  fastify.get(
    `${basePath}/resources/:uri`,
    {
      schema: {
        tags: ["mcp-apps"],
        summary: "Get MCP App UI resource",
        description: "获取 MCP App 的 UI 资源内容",
        params: z.object({
          uri: z.string().describe("UI resource URI (base64 encoded)"),
        }),
        querystring: z.object({
          agentId: UuidIdSchema,
        }),
        response: {
          200: constructResponseSchema(
            z.object({
              uri: z.string(),
              mimeType: z.string(),
              text: z.string().optional(),
              blob: z.string().optional(),
            }),
          ),
          ...ErrorResponsesSchema,
        },
      },
    },
    async (request, reply) => {
      const { user, organizationId } = request;
      const { uri: encodedUri } = request.params as { uri: string };
      const { agentId } = request.query as { agentId: string };

      // 检查权限
      const hasAccess = await userHasPermission(
        user.id,
        organizationId,
        "profile",
        "read",
      );
      if (!hasAccess) {
        throw new ApiError(403, "No permission to access this agent");
      }

      // 解码 URI
      let uri: string;
      try {
        uri = Buffer.from(encodedUri, "base64url").toString("utf-8");
      } catch {
        throw new ApiError(400, "Invalid URI encoding");
      }

      // 解析 URI
      const parsedUri = parseUIUri(uri);
      if (!parsedUri) {
        throw new ApiError(400, "Invalid UI URI format");
      }

      const { serverName, resourcePath } = parsedUri;

      // 解析 server
      const resolved = await resolveServerByName(serverName, agentId, user.id);
      if (!resolved) {
        throw new ApiError(404, "MCP server not found");
      }

      const { catalogItem, targetMcpServerId } = resolved;

      // 获取 secrets
      const mcpServer = await McpServerModel.findById(targetMcpServerId);
      if (!mcpServer) {
        throw new ApiError(404, "MCP server not found");
      }

      let secrets: Record<string, unknown> = {};
      if (mcpServer.secretId) {
        const { secretManager } = await import("@/secrets-manager");
        const secret = await secretManager().getSecret(mcpServer.secretId);
        if (secret?.secret) {
          secrets = secret.secret;
        }
      }

      // 获取资源
      try {
        // 使用 MCP client 读取资源
        // 注意：这里我们使用 resources/read 方法
        const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
        const transport = await mcpClient["getTransport"](
          catalogItem,
          targetMcpServerId,
          secrets,
        );

        const client = new Client(
          {
            name: "archestra-mcp-apps",
            version: config.api.version,
          },
          { capabilities: {} },
        );

        await client.connect(transport);

        // 尝试读取资源
        const resourceResult = await client.readResource({
          uri: `ui://${resourcePath}`,
        });

        await client.close();

        // 提取资源内容
        const contents = resourceResult.contents;
        if (!contents || contents.length === 0) {
          throw new ApiError(404, "Resource not found");
        }

        const content = contents[0];
        
        // 返回资源 - 处理 text 或 blob
        const responseData: {
          uri: string;
          mimeType: string;
          text?: string;
          blob?: string;
        } = {
          uri: content.uri || uri,
          mimeType: content.mimeType || "text/html",
        };

        // 根据内容类型设置 text 或 blob
        if ("text" in content && typeof content.text === "string") {
          responseData.text = content.text;
        }
        if ("blob" in content && typeof content.blob === "string") {
          responseData.blob = content.blob;
        }
        
        return {
          data: responseData,
        };
      } catch (error) {
        logger.error({ uri, error }, "Failed to fetch MCP App resource");
        throw new ApiError(500, "Failed to fetch resource");
      }
    },
  );

  // ===========================================================================
  // POST /api/mcp-apps/tools/:toolName/call - 调用工具并返回 MCP App 结果
  // ===========================================================================
  fastify.post(
    `${basePath}/tools/:toolName/call`,
    {
      schema: {
        tags: ["mcp-apps"],
        summary: "Call MCP App tool",
        description: "调用 MCP App 工具并返回结果",
        params: z.object({
          toolName: z.string(),
        }),
        body: z.object({
          agentId: UuidIdSchema,
          arguments: z.record(z.string(), z.unknown()),
          conversationId: z.string().optional(),
        }),
        response: {
          200: constructResponseSchema(
            z.object({
              content: z.unknown(),
              isError: z.boolean(),
              resourceUri: z.string().optional(),
            }),
          ),
          ...ErrorResponsesSchema,
        },
      },
    },
    async (request, reply) => {
      const { user, organizationId } = request;
      const { toolName } = request.params as { toolName: string };
      const { agentId, arguments: args, conversationId } = request.body as {
        agentId: string;
        arguments: Record<string, unknown>;
        conversationId?: string;
      };

      // 检查权限
      const hasAccess = await userHasPermission(
        user.id,
        organizationId,
        "profile",
        "read",
      );
      if (!hasAccess) {
        throw new ApiError(403, "No permission to execute tools");
      }

      // 调用工具
      const toolCall = {
        id: `mcp-app-${Date.now()}`,
        name: toolName,
        arguments: args,
      };

      const tokenAuthContext: TokenAuthContext = {
        tokenId: user.id,
        teamId: null,
        isOrganizationToken: false,
        organizationId,
        isUserToken: true,
        userId: user.id,
      };

      try {
        const result = await mcpClient.executeToolCall(
          toolCall,
          agentId,
          tokenAuthContext,
          { conversationId },
        );

        // 检查是否包含 MCP App 资源
        const resources = result.content as unknown[];
        let resourceUri: string | undefined;

        for (const item of resources) {
          if (
            typeof item === "object" &&
            item !== null &&
            "type" in item &&
            item.type === "resource" &&
            "resource" in item
          ) {
            const resource = (item as { resource: { uri: string } }).resource;
            resourceUri = resource.uri;
            break;
          }
        }

        return {
          data: {
            content: result.content,
            isError: result.isError,
            resourceUri,
          },
        };
      } catch (error) {
        logger.error({ toolName, error }, "Failed to call MCP App tool");
        throw new ApiError(500, "Tool call failed");
      }
    },
  );
};
