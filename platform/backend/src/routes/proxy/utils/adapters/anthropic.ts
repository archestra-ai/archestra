import { encode as toonEncode } from "@toon-format/toon";
import logger from "@/logging";
import { TokenPriceModel } from "@/models";
import { getTokenizer } from "@/tokenizers";
import type {
  Anthropic,
  CommonMessage,
  CommonToolCall,
  CommonToolResult,
  ToolResultUpdates,
} from "@/types";
import type { CompressionStats } from "../toon-conversion";
import { unwrapToolContent } from "../unwrap-tool-content";

type AnthropicMessages = Anthropic.Types.MessagesRequest["messages"];

/**
 * Convert Anthropic messages to common format for trusted data evaluation
 */
export function toCommonFormat(messages: AnthropicMessages): CommonMessage[] {
  const commonMessages: CommonMessage[] = [];

  for (const message of messages) {
    const commonMessage: CommonMessage = {
      role: message.role as CommonMessage["role"],
    };

    // Handle user messages that may contain tool results
    if (message.role === "user" && Array.isArray(message.content)) {
      const toolCalls: CommonToolResult[] = [];

      for (const contentBlock of message.content) {
        if (contentBlock.type === "tool_result") {
          // Find the tool name from previous assistant messages
          const toolName = extractToolNameFromMessages(
            messages,
            contentBlock.tool_use_id,
          );

          if (toolName) {
            // Parse the tool result
            let toolResult: unknown;
            if (typeof contentBlock.content === "string") {
              try {
                toolResult = JSON.parse(contentBlock.content);
              } catch {
                toolResult = contentBlock.content;
              }
            } else {
              toolResult = contentBlock.content;
            }

            toolCalls.push({
              id: contentBlock.tool_use_id,
              name: toolName,
              content: toolResult,
              isError: false,
            });
          }
        }
      }

      if (toolCalls.length > 0) {
        commonMessage.toolCalls = toolCalls;
      }
    }

    commonMessages.push(commonMessage);
  }

  return commonMessages;
}

/**
 * Apply tool result updates back to Anthropic messages
 */
export function applyUpdates(
  messages: AnthropicMessages,
  updates: ToolResultUpdates,
): AnthropicMessages {
  if (Object.keys(updates).length === 0) {
    return messages;
  }

  return messages.map((message) => {
    // Only process user messages with content arrays
    if (message.role === "user" && Array.isArray(message.content)) {
      const updatedContent = message.content.map((contentBlock) => {
        if (
          contentBlock.type === "tool_result" &&
          updates[contentBlock.tool_use_id]
        ) {
          return {
            ...contentBlock,
            content: updates[contentBlock.tool_use_id],
          };
        }
        return contentBlock;
      });

      return {
        ...message,
        content: updatedContent,
      };
    }

    return message;
  });
}

/**
 * Extract tool name from messages by finding the assistant message
 * that contains the tool_use_id
 */
function extractToolNameFromMessages(
  messages: AnthropicMessages,
  toolUseId: string,
): string | null {
  // Find the most recent assistant message with tool_use blocks
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];

    if (
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.length > 0
    ) {
      for (const content of message.content) {
        if (content.type === "tool_use") {
          if (content.id === toolUseId) {
            return content.name;
          }
        }
      }
    }
  }

  return null;
}

/**
 * Extract the user's original request from Anthropic messages
 * Gets the last user message that doesn't contain tool results
 */
export function extractUserRequest(messages: AnthropicMessages): string {
  // Find the last user message that doesn't contain tool_result blocks
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") {
      if (typeof message.content === "string") {
        return message.content;
      }
      // If content is an array, look for text blocks (not tool_result blocks)
      if (Array.isArray(message.content)) {
        const textBlock = message.content.find(
          (block) =>
            block.type === "text" &&
            "text" in block &&
            typeof block.text === "string",
        );
        if (textBlock && "text" in textBlock) {
          return textBlock.text;
        }
      }
    }
  }
  return "process this data";
}

/**
 * Convert Anthropic tool use blocks to common format for MCP execution
 */
export function toolCallsToCommon(
  toolUseBlocks: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>,
): CommonToolCall[] {
  return toolUseBlocks.map((toolUse) => ({
    id: toolUse.id,
    name: toolUse.name,
    arguments: toolUse.input,
  }));
}

/**
 * Convert common tool results to Anthropic user message with tool_result blocks
 */
export function toolResultsToMessages(
  results: CommonToolResult[],
  convertToToon = false,
): Array<{
  role: "user";
  content: Array<{
    type: "tool_result";
    tool_use_id: string;
    content: string;
    is_error?: boolean;
  }>;
}> {
  if (results.length === 0) {
    return [];
  }

  return [
    {
      role: "user" as const,
      content: results.map((result) => {
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
          type: "tool_result" as const,
          tool_use_id: result.id,
          content,
          is_error: result.isError,
        };
      }),
    },
  ];
}

/**
 * Convert tool results in messages to TOON format
 * Returns both the converted messages and compression stats (tokens and cost savings)
 */
export async function convertToolResultsToToon(
  messages: AnthropicMessages,
  model: string,
): Promise<{
  messages: AnthropicMessages;
  stats: CompressionStats;
}> {
  const tokenizer = getTokenizer("anthropic");
  let toolResultCount = 0;
  let totalTokensBefore = 0;
  let totalTokensAfter = 0;

  const result = messages.map((message) => {
    // Only process user messages with content arrays that contain tool_result blocks
    if (message.role === "user" && Array.isArray(message.content)) {
      const updatedContent = message.content.map((contentBlock) => {
        if (contentBlock.type === "tool_result" && !contentBlock.is_error) {
          toolResultCount++;
          logger.info(
            {
              toolCallId: contentBlock.tool_use_id,
              contentType: typeof contentBlock.content,
              isArray: Array.isArray(contentBlock.content),
            },
            "Processing tool_result for TOON conversion",
          );

          // Handle string content
          if (typeof contentBlock.content === "string") {
            try {
              // Unwrap any extra text block wrapping from clients
              const unwrapped = unwrapToolContent(contentBlock.content);
              const parsed = JSON.parse(unwrapped);
              const noncompressed = unwrapped;
              const compressed = toonEncode(parsed);

              // Count tokens for before and after
              const tokensBefore = tokenizer.countTokens([
                { role: "user", content: noncompressed },
              ]);
              const tokensAfter = tokenizer.countTokens([
                { role: "user", content: compressed },
              ]);
              totalTokensBefore += tokensBefore;
              totalTokensAfter += tokensAfter;

              logger.info(
                {
                  toolCallId: contentBlock.tool_use_id,
                  beforeLength: noncompressed.length,
                  afterLength: compressed.length,
                  tokensBefore,
                  tokensAfter,
                  toonPreview: compressed.substring(0, 150),
                  provider: "anthropic",
                },
                "convertToolResultsToToon: compressed (string content)",
              );
              logger.debug(
                {
                  toolCallId: contentBlock.tool_use_id,
                  before: noncompressed,
                  after: compressed,
                  provider: "anthropic",
                  supposedToBeJson: parsed,
                },
                "convertToolResultsToToon: before/after",
              );

              return {
                ...contentBlock,
                content: compressed,
              };
            } catch {
              logger.info(
                {
                  toolCallId: contentBlock.tool_use_id,
                  contentPreview:
                    typeof contentBlock.content === "string"
                      ? contentBlock.content.substring(0, 100)
                      : "non-string",
                },
                "convertToolResultsToToon: skipping - string content is not JSON",
              );
              return contentBlock;
            }
          }

          // Handle array content (content blocks format)
          if (Array.isArray(contentBlock.content)) {
            const updatedBlocks = contentBlock.content.map((block) => {
              if (block.type === "text" && typeof block.text === "string") {
                try {
                  // Unwrap any extra text block wrapping from clients
                  const unwrapped = unwrapToolContent(block.text);
                  // Try to parse as JSON
                  const parsed = JSON.parse(unwrapped);
                  const noncompressed = unwrapped;
                  const compressed = toonEncode(parsed);

                  // Count tokens for before and after
                  const tokensBefore = tokenizer.countTokens([
                    { role: "user", content: noncompressed },
                  ]);
                  const tokensAfter = tokenizer.countTokens([
                    { role: "user", content: compressed },
                  ]);

                  // Track compression stats in tokens
                  totalTokensBefore += tokensBefore;
                  totalTokensAfter += tokensAfter;

                  logger.info(
                    {
                      toolCallId: contentBlock.tool_use_id,
                      beforeLength: noncompressed.length,
                      afterLength: compressed.length,
                      tokensBefore,
                      tokensAfter,
                      toonPreview: compressed.substring(0, 150),
                    },
                    "convertToolResultsToToon: compressed (array content)",
                  );
                  logger.debug(
                    {
                      toolCallId: contentBlock.tool_use_id,
                      before: noncompressed,
                      after: compressed,
                      provider: "anthropic",
                      supposedToBeJson: parsed,
                    },
                    "convertToolResultsToToon: before/after",
                  );

                  return {
                    ...block,
                    text: compressed,
                  };
                } catch {
                  // Not JSON, keep as-is
                  logger.info(
                    {
                      toolCallId: contentBlock.tool_use_id,
                      blockType: block.type,
                      textPreview: block.text?.substring(0, 100),
                    },
                    "convertToolResultsToToon: skipping - content is not JSON",
                  );
                  return block;
                }
              }
              return block;
            });

            return {
              ...contentBlock,
              content: updatedBlocks,
            };
          }
        }
        return contentBlock;
      });

      return {
        ...message,
        content: updatedContent,
      };
    }

    return message;
  });

  logger.info(
    { messageCount: messages.length, toolResultCount },
    "convertToolResultsToToon completed",
  );

  // Calculate cost savings
  let toonCostSavings: number | null = null;
  if (toolResultCount > 0) {
    const tokensSaved = totalTokensBefore - totalTokensAfter;
    if (tokensSaved > 0) {
      const tokenPrice = await TokenPriceModel.findByModel(model);
      if (tokenPrice) {
        const inputPricePerToken =
          Number(tokenPrice.pricePerMillionInput) / 1000000;
        toonCostSavings = tokensSaved * inputPricePerToken;
      }
    }
  }

  return {
    messages: result,
    stats: {
      toonTokensBefore: toolResultCount > 0 ? totalTokensBefore : null,
      toonTokensAfter: toolResultCount > 0 ? totalTokensAfter : null,
      toonCostSavings,
    },
  };
}

/** Returns input and output usage tokens */
export function getUsageTokens(usage: Anthropic.Types.Usage) {
  return {
    input: usage.input_tokens,
    output: usage.output_tokens,
  };
}
