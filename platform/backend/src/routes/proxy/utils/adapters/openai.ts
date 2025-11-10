import type { z } from "zod";
import { isOpenAIPricingModel, llmPricing } from "@/llm-pricing";
import type { CommonToolCall, CommonToolResult, OpenAi } from "@/types";
import type { CommonMessage, ToolResultUpdates } from "../types";

type OpenAiMessages = OpenAi.Types.ChatCompletionsRequest["messages"];
type OpenAiModel = OpenAi.Types.ChatCompletionsRequest["model"];

/**
 * Convert OpenAI messages to common format for trusted data evaluation
 */
export function toCommonFormat(messages: OpenAiMessages): CommonMessage[] {
  const commonMessages: CommonMessage[] = [];

  for (const message of messages) {
    const commonMessage: CommonMessage = {
      role: message.role as CommonMessage["role"],
    };

    // Handle assistant messages with tool calls
    if (message.role === "assistant" && message.tool_calls) {
      // We don't include tool calls in assistant messages for evaluation
      // We only care about tool results
    }

    // Handle tool messages (tool results)
    if (message.role === "tool") {
      // Find the corresponding tool call to get the tool name
      const toolName = extractToolNameFromMessages(
        messages,
        message.tool_call_id,
      );

      if (toolName) {
        // Parse the tool result
        let toolResult: unknown;
        if (typeof message.content === "string") {
          try {
            toolResult = JSON.parse(message.content);
          } catch {
            toolResult = message.content;
          }
        } else {
          toolResult = message.content;
        }

        // Add as a tool call in common format
        commonMessage.toolCalls = [
          {
            id: message.tool_call_id,
            name: toolName,
            result: toolResult,
          },
        ];
      }
    }

    commonMessages.push(commonMessage);
  }

  return commonMessages;
}

/**
 * Apply tool result updates back to OpenAI messages
 */
export function applyUpdates(
  messages: OpenAiMessages,
  updates: ToolResultUpdates,
): OpenAiMessages {
  if (Object.keys(updates).length === 0) {
    return messages;
  }

  return messages.map((message) => {
    if (message.role === "tool" && updates[message.tool_call_id]) {
      return {
        ...message,
        content: updates[message.tool_call_id],
      };
    }
    return message;
  });
}

/**
 * Extract tool name from messages by finding the assistant message
 * that contains the tool_call_id
 */
function extractToolNameFromMessages(
  messages: OpenAiMessages,
  toolCallId: string,
): string | null {
  // Find the most recent assistant message with tool_calls
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];

    if (message.role === "assistant" && message.tool_calls) {
      for (const toolCall of message.tool_calls) {
        if (toolCall.id === toolCallId) {
          if (toolCall.type === "function") {
            return toolCall.function.name;
          } else {
            return toolCall.custom.name;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Extract the user's original request from OpenAI messages
 */
export function extractUserRequest(messages: OpenAiMessages): string {
  const userContent =
    messages.filter((m) => m.role === "user").slice(-1)[0]?.content ||
    "process this data";

  // Convert to string if it's an array (multimodal content)
  return typeof userContent === "string"
    ? userContent
    : JSON.stringify(userContent);
}

/**
 * Convert OpenAI tool calls to common format for MCP execution
 */
export function toolCallsToCommon(
  toolCalls: Array<{
    id: string;
    type: string;
    function?: { name: string; arguments: string };
    custom?: { name: string; input: string };
  }>,
): CommonToolCall[] {
  return toolCalls.map((toolCall) => {
    let name: string;
    let args: Record<string, unknown>;

    if (toolCall.type === "function" && toolCall.function) {
      name = toolCall.function.name;
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        args = {};
      }
    } else if (toolCall.custom) {
      name = toolCall.custom.name;
      try {
        args = JSON.parse(toolCall.custom.input);
      } catch {
        args = {};
      }
    } else {
      name = "unknown";
      args = {};
    }

    return {
      id: toolCall.id,
      name,
      arguments: args,
    };
  });
}

/**
 * Convert common tool results to OpenAI tool message format
 */
export function toolResultsToMessages(
  results: CommonToolResult[],
): Array<{ role: "tool"; tool_call_id: string; content: string }> {
  return results.map((result) => ({
    role: "tool" as const,
    tool_call_id: result.id,
    content: result.isError
      ? `Error: ${result.error || "Tool execution failed"}`
      : JSON.stringify(result.content),
  }));
}

/** Returns input and output usage tokens */
export function getUsageTokens(usage: OpenAi.Types.Usage) {
  return {
    input: usage.prompt_tokens,
    output: usage.completion_tokens,
  };
}

/** Returns the usage cost in USD */
export function getUsageCost(
  model: keyof typeof llmPricing.openai,
  { input = 0, output = 0 }: { input?: number; output?: number },
): number {
  const pricing = llmPricing.openai[model];
  return (input * pricing.input + output * pricing.output) / 1000000;
}

/**
 * Selects optimal OpenAI model in terms of cost.
 * The selection is based on context length, attachments and tool presence.
 */
export function getOptimizedModel(
  model: string,
  tools: z.infer<typeof OpenAi.Tools.ToolSchema>[] | undefined,
  messages: OpenAiMessages,
): string {
  const normalizedModel = normalizeModel(model);
  if (!isOpenAIPricingModel(normalizedModel)) {
    return model;
  }

  const mini = "gpt-4o-mini" as const;
  const originalPricing = llmPricing.openai[normalizedModel];
  const optimizedPricing = llmPricing.openai[mini];
  if (
    originalPricing.input <= optimizedPricing.input ||
    originalPricing.output <= optimizedPricing.input
  ) {
    return model;
  }
  let contextLength = 0;
  let hasAttachments = false;
  for (const message of messages) {
    if (typeof message.content === "string") {
      contextLength += message.content.length;
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text") {
          contextLength += part.text.length;
        } else {
          hasAttachments = true;
        }
      }
    }
  }

  const hasTools = tools && tools.length > 0;
  const shortContext = contextLength < 10000;
  if (shortContext && !hasAttachments && !hasTools) {
    return mini;
  } else {
    return model;
  }
}

/** Normalizes a model's name, removing snapshot and other irrelevant suffixes. */
export function normalizeModel(model: string): string {
  let normalized = model;

  // Remove date suffix as in "gpt-4o-2024-11-20"
  normalized = normalized.replace(/-\d{4}-\d{2}-\d{2}$/, "");

  // Remove 4-digit version code as in "gpt-4-0125-preview"
  normalized = normalized.replace(/-\d{4}(?=-|$)/g, "");

  // Remove common version suffixes
  normalized = normalized.replace(/-(latest|preview)/, "");
  normalized = normalized.replace(/chatgpt/, "gpt");

  return normalized;
}
