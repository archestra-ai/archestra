import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import config from "@/config";
import logger from "@/logging";
import { AgentModel } from "@/models";
import {
  ApiError,
  constructResponseSchema,
  ErrorResponsesSchema,
  UuidIdSchema,
} from "@/types";

// =============================================================================
// LLM Gateway MCP Apps 支持
// 提供 LLM Gateway 层面的 MCP Apps 上下文支持
// =============================================================================

/**
 * MCP Apps 上下文信息
 * 用于在 LLM 响应中嵌入 MCP App 渲染信息
 */
export interface McpAppsContext {
  /** 是否启用 MCP Apps */
  enabled: boolean;
  /** 可用的 MCP Apps 工具列表 */
  availableTools: Array<{
    name: string;
    resourceUri: string;
    permissions?: string[];
  }>;
  /** 沙盒配置 */
  sandboxConfig: {
    /** 沙盒 URL */
    url: string;
    /** CSP 配置 */
    csp?: Record<string, string>;
  };
}

/**
 * 生成 MCP Apps 系统提示词
 * 告诉 LLM 如何使用 MCP Apps
 */
export function generateMcpAppsSystemPrompt(context: McpAppsContext): string {
  if (!context.enabled || context.availableTools.length === 0) {
    return "";
  }

  const toolsList = context.availableTools
    .map((tool) => `- ${tool.name}: ${tool.resourceUri}`)
    .join("\n");

  return `
## MCP Apps 支持

你可以使用以下 MCP Apps 来提供交互式界面：

${toolsList}

当调用这些工具时，系统会自动渲染对应的交互式 UI。
用户可以在聊天界面中直接与这些应用交互。
`;
}

/**
 * LLM Gateway MCP Apps 路由
 */
export const llmGatewayMcpAppsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const basePath = "/api/llm-gateway/mcp-apps";

  // ===========================================================================
  // GET /api/llm-gateway/mcp-apps/context - 获取 MCP Apps 上下文
  // ===========================================================================
  fastify.get(
    `${basePath}/context`,
    {
      schema: {
        tags: ["llm-gateway"],
        summary: "Get MCP Apps context for LLM",
        description: "获取用于 LLM 的 MCP Apps 上下文信息",
        querystring: z.object({
          agentId: UuidIdSchema,
        }),
        response: {
          200: constructResponseSchema(
            z.object({
              enabled: z.boolean(),
              availableTools: z.array(
                z.object({
                  name: z.string(),
                  resourceUri: z.string(),
                  permissions: z.array(z.string()).optional(),
                }),
              ),
              sandboxConfig: z.object({
                url: z.string(),
                csp: z.record(z.string(), z.string()).optional(),
              }),
            }),
          ),
          ...ErrorResponsesSchema,
        },
      },
    },
    async (request, reply) => {
      const { user, organizationId } = request;
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

      // 构建 MCP Apps 上下文
      // 这里简化处理，实际应该从配置或数据库获取
      const context: McpAppsContext = {
        enabled: true,
        availableTools: [], // 将在实际使用时填充
        sandboxConfig: {
          url: `${config.frontendBaseUrl}/mcp-app-sandbox.html`,
          csp: {
            "default-src": "'self'",
            "script-src": "'self' 'unsafe-inline'",
            "style-src": "'self' 'unsafe-inline'",
            "connect-src": "'self'",
          },
        },
      };

      return {
        data: context,
      };
    },
  );

  // ===========================================================================
  // POST /api/llm-gateway/mcp-apps/render - 渲染 MCP App
  // ===========================================================================
  fastify.post(
    `${basePath}/render`,
    {
      schema: {
        tags: ["llm-gateway"],
        summary: "Render MCP App",
        description: "渲染 MCP App 并返回渲染配置",
        body: z.object({
          agentId: UuidIdSchema,
          toolName: z.string(),
          toolInput: z.record(z.string(), z.unknown()).optional(),
          toolResult: z.unknown().optional(),
          resourceUri: z.string().optional(),
        }),
        response: {
          200: constructResponseSchema(
            z.object({
              renderConfig: z.object({
                type: z.literal("mcp-app"),
                resourceUri: z.string(),
                sandboxUrl: z.string(),
                csp: z.record(z.string(), z.string()).optional(),
                permissions: z.array(z.string()).optional(),
              }),
            }),
          ),
          ...ErrorResponsesSchema,
        },
      },
    },
    async (request, reply) => {
      const { user, organizationId } = request;
      const { agentId, toolName, toolInput, toolResult, resourceUri } =
        request.body as {
          agentId: string;
          toolName: string;
          toolInput?: Record<string, unknown>;
          toolResult?: unknown;
          resourceUri?: string;
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

      // 验证 agent 存在
      const agent = await AgentModel.findById(agentId);
      if (!agent) {
        throw new ApiError(404, "Agent not found");
      }

      // 如果没有提供 resourceUri，需要从工具定义中获取
      let finalResourceUri = resourceUri;
      if (!finalResourceUri) {
        // 这里应该查询工具定义获取 resourceUri
        // 简化处理，假设 resourceUri 格式为 ui://{serverName}/{toolName}
        const serverName = toolName.split("__")[0] || "default";
        const shortToolName = toolName.split("__").pop() || toolName;
        finalResourceUri = `ui://${serverName}/${shortToolName}`;
      }

      return {
        data: {
          renderConfig: {
            type: "mcp-app" as const,
            resourceUri: finalResourceUri,
            sandboxUrl: `${config.frontendBaseUrl}/mcp-app-sandbox.html`,
            csp: {
              "default-src": "'self'",
              "script-src": "'self' 'unsafe-inline'",
              "style-src": "'self' 'unsafe-inline'",
              "connect-src": "'self'",
            },
            permissions: [],
          },
        },
      };
    },
  );
};

/**
 * 检查消息是否包含 MCP App 资源
 */
export function containsMcpAppResource(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }

  return content.some((item) => {
    if (typeof item !== "object" || item === null) {
      return false;
    }
    return (
      item.type === "resource" &&
      item.resource?.uri?.startsWith("ui://")
    );
  });
}

/**
 * 从工具结果中提取 MCP App 资源 URI
 */
export function extractMcpAppResourceUri(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }

  for (const item of content) {
    if (
      typeof item === "object" &&
      item !== null &&
      item.type === "resource" &&
      item.resource?.uri?.startsWith("ui://")
    ) {
      return item.resource.uri as string;
    }
  }

  return null;
}
