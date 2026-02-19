import { z } from "zod";

/**
 * MCP Apps UI 元数据类型定义
 * 基于 MCP Apps 协议规范: https://modelcontextprotocol.io/docs/extensions/apps
 */

/**
 * UI 资源权限配置
 */
export const McpAppPermissionsSchema = z.object({
  /** 请求的额外权限，如 microphone, camera 等 */
  permissions: z.array(z.string()).optional(),
  /** 内容安全策略配置 */
  csp: z.record(z.string(), z.array(z.string())).optional(),
});

export type McpAppPermissions = z.infer<typeof McpAppPermissionsSchema>;

/**
 * MCP App UI 元数据
 * 用于在工具定义中声明关联的 UI 资源
 */
export const McpAppUIMetaSchema = z.object({
  /** UI 资源 URI，格式为 ui://server-name/resource-path */
  resourceUri: z.string(),
  /** 可选的权限配置 */
  permissions: z.array(z.string()).optional(),
  /** 可选的 CSP 配置 */
  csp: z.record(z.string(), z.array(z.string())).optional(),
});

export type McpAppUIMeta = z.infer<typeof McpAppUIMetaSchema>;

/**
 * MCP App 工具元数据
 */
export const McpAppToolMetaSchema = z.object({
  /** UI 相关配置 */
  ui: McpAppUIMetaSchema.optional(),
});

export type McpAppToolMeta = z.infer<typeof McpAppToolMetaSchema>;

/**
 * UI 资源定义
 */
export const McpAppUIResourceSchema = z.object({
  type: z.literal("resource"),
  resource: z.object({
    /** 资源 URI */
    uri: z.string(),
    /** MIME 类型 */
    mimeType: z.union([
      z.literal("text/html"),
      z.literal("text/html;profile=mcp-app"),
      z.literal("text/uri-list"),
      z.literal("application/vnd.mcp-ui.remote-dom"),
    ]),
    /** 文本内容（内联 HTML 或 URL） */
    text: z.string().optional(),
    /** Base64 编码的二进制内容 */
    blob: z.string().optional(),
  }),
});

export type McpAppUIResource = z.infer<typeof McpAppUIResourceSchema>;

/**
 * 扩展的工具定义，包含 MCP Apps 支持
 */
export interface CommonMcpToolDefinitionWithApps {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  /** MCP Apps 元数据 */
  _meta?: {
    ui?: {
      resourceUri: string;
      permissions?: string[];
      csp?: Record<string, string[]>;
    };
  };
}

/**
 * 工具调用结果中的 MCP App 资源引用
 */
export const McpAppResourceReferenceSchema = z.object({
  type: z.literal("resource"),
  resource: z.object({
    uri: z.string(),
    mimeType: z.string(),
    text: z.string().optional(),
    blob: z.string().optional(),
  }),
});

export type McpAppResourceReference = z.infer<
  typeof McpAppResourceReferenceSchema
>;

/**
 * 检查工具是否有 MCP App UI 支持
 */
export function hasMcpAppUI(
  tool: CommonMcpToolDefinitionWithApps,
): tool is CommonMcpToolDefinitionWithApps & {
  _meta: { ui: { resourceUri: string } };
} {
  return (
    tool._meta?.ui?.resourceUri !== undefined &&
    typeof tool._meta.ui.resourceUri === "string"
  );
}

/**
 * 检查工具调用结果是否包含 MCP App 资源
 */
export function isMcpAppResource(
  content: unknown,
): content is McpAppResourceReference {
  if (typeof content !== "object" || content === null) {
    return false;
  }
  const obj = content as Record<string, unknown>;
  return (
    obj.type === "resource" &&
    typeof obj.resource === "object" &&
    obj.resource !== null &&
    typeof (obj.resource as Record<string, unknown>).uri === "string"
  );
}

/**
 * 从工具调用结果中提取 MCP App 资源
 */
export function extractMcpAppResources(
  content: unknown,
): McpAppResourceReference[] {
  if (!Array.isArray(content)) {
    return isMcpAppResource(content) ? [content] : [];
  }

  return content.filter((item): item is McpAppResourceReference =>
    isMcpAppResource(item),
  );
}
