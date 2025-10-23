export interface CommonMcpToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Provider-agnostic representation of a tool call from an LLM
 */
export interface CommonToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Provider-agnostic representation of a tool execution result
 */
export interface CommonToolResult {
  id: string;
  content: unknown;
  isError: boolean;
  error?: string;
}

/**
 * MCP server configuration needed for tool execution
 *
 * NOTE: for right now this really only supports remote MCP servers and will of course need to be expanded out...
 */
export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  headers: Record<string, string>;
}

/**
 * Tool information with associated MCP server details
 */
export interface ToolWithServer {
  toolId: string;
  toolName: string;
  mcpServer: McpServerConfig;
}
