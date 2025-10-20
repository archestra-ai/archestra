export type SupportedProviders = "openai" | "anthropic";

/**
 * Represents a tool call in a provider-agnostic way
 */
export interface CommonToolCall {
  /** Unique identifier for the tool call */
  id: string;
  /** Name of the tool being called */
  name: string;
  /** The result/output from the tool execution */
  result: unknown;
}

/**
 * Common message format for evaluating trusted data
 * Only includes the information needed for trusted data evaluation
 */
export interface CommonMessage {
  /** Message role */
  role: "user" | "assistant" | "tool" | "system" | "model" | "function";
  /** Tool calls if this message contains them */
  toolCalls?: CommonToolCall[];
}

/**
 * Result of evaluating trusted data policies
 * Maps tool call IDs to their updated content (if modified)
 */
export type ToolResultUpdates = Record<string, string>;

/**
 * Parameters for creating a DualLlmSubagent in a provider-agnostic way
 */
export interface CommonDualLlmParams {
  /** The tool call ID for tracking */
  toolCallId: string;
  /** The original user request */
  userRequest: string;
  /** The tool result to be analyzed */
  toolResult: unknown;
}
