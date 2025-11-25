import { encode as toonEncode } from "@toon-format/toon";
import logger from "@/logging";
import type {
  CommonMessage,
  CommonToolCall,
  CommonToolResult,
  OpenAi,
  ToolResultUpdates,
} from "@/types";

type OpenAiMessages = OpenAi.Types.ChatCompletionsRequest["messages"];

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
            content: toolResult,
            isError: false,
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
  convertToToon = false,
): Array<{ role: "tool"; tool_call_id: string; content: string }> {
  return results.map((result) => {
    let content: string;
    if (result.isError) {
      content = `Error: ${result.error || "Tool execution failed"}`;
    } else if (convertToToon) {
      const beforeJson = JSON.stringify(result.content);
      const afterToon = toonEncode(result.content);
      logger.info(
        {
          toolName: result.name,
          toolCallId: result.id,
          beforeLength: beforeJson.length,
          afterLength: afterToon.length,
          compressionRatio: (
            (1 - afterToon.length / beforeJson.length) *
            100
          ).toFixed(2),
        },
        "TOON conversion completed",
      );
      logger.debug(
        {
          toolName: result.name,
          toolCallId: result.id,
          before: beforeJson,
          after: afterToon,
        },
        "TOON conversion before/after",
      );
      content = afterToon;
    } else {
      content = JSON.stringify(result.content);
    }

    return {
      role: "tool" as const,
      tool_call_id: result.id,
      content,
    };
  });
}

/**
 * Convert tool results in messages to TOON format
 * Returns both the converted messages and compression statistics
 */
export function convertToolResultsToToon(messages: OpenAiMessages): {
  messages: OpenAiMessages;
  compressionStats: {
    totalBeforeLength: number;
    totalAfterLength: number;
    toolResults: number;
  };
} {
  let totalBeforeLength = 0;
  let totalAfterLength = 0;
  let toolResults = 0;

  const result = messages.map((message) => {
    // Only process tool messages (tool results)
    if (message.role === "tool") {
      // Only convert string content
      if (typeof message.content === "string") {
        try {
          // Parse JSON to validate it's actually JSON
          const parsed = JSON.parse(message.content);
          const beforeJson = message.content;
          const afterToon = toonEncode(parsed);

          // Track compression stats
          totalBeforeLength += beforeJson.length;
          totalAfterLength += afterToon.length;
          toolResults++;

          logger.info(
            {
              toolCallId: message.tool_call_id,
              beforeLength: beforeJson.length,
              afterLength: afterToon.length,
              compressionRatio: (
                (1 - afterToon.length / beforeJson.length) *
                100
              ).toFixed(2),
            },
            "TOON conversion completed",
          );
          logger.debug(
            {
              toolCallId: message.tool_call_id,
              before: beforeJson,
              after: afterToon,
            },
            "TOON conversion before/after",
          );

          return {
            ...message,
            content: afterToon,
          };
        } catch {
          // If it's not valid JSON, skip conversion
          logger.debug(
            {
              toolCallId: message.tool_call_id,
              reason: "not_valid_json",
            },
            "Skipping TOON conversion",
          );
          return message;
        }
      }
    }

    return message;
  });

  return {
    messages: result,
    compressionStats: {
      totalBeforeLength,
      totalAfterLength,
      toolResults,
    },
  };
}

/** Returns input and output usage tokens */
export function getUsageTokens(usage: OpenAi.Types.Usage) {
  return {
    input: usage.prompt_tokens,
    output: usage.completion_tokens,
  };
}
