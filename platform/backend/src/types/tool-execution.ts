export type CommonMcpToolDefinition = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

/**
 * Provider-agnostic representation of a tool call from an LLM
 */
export type CommonToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

/**
 * Provider-agnostic representation of a tool execution result
 */
export type CommonToolResult = {
  id: string;
  content: unknown;
  isError: boolean;
  error?: string;
};
