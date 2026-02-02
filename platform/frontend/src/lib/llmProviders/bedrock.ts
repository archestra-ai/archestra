import type { PartialUIMessage } from "@/components/chatbot-demo";
import type { DualLlmResult, Interaction, InteractionUtils } from "./common";

/**
 * Bedrock Converse API request/response types
 * Based on backend/src/types/llm-providers/bedrock/api.ts
 */
interface BedrockContentBlock {
  text?: string;
  toolUse?: {
    toolUseId: string;
    name: string;
    input: unknown;
  };
  toolResult?: {
    toolUseId: string;
    content: unknown;
    status?: string;
  };
  guardContent?: unknown;
  document?: unknown;
  image?: unknown;
  video?: unknown;
}

interface BedrockMessage {
  role: "user" | "assistant";
  content: BedrockContentBlock[];
}

interface BedrockResponseContentBlock {
  text?: string;
  toolUse?: {
    toolUseId: string;
    name: string;
    input: unknown;
  };
  reasoningContent?: unknown;
}

interface BedrockConverseRequest {
  modelId: string;
  messages?: BedrockMessage[];
  system?: unknown;
  inferenceConfig?: unknown;
  toolConfig?: unknown;
}

interface BedrockConverseResponse {
  output?: {
    message?: {
      role: "assistant";
      content: BedrockResponseContentBlock[];
    };
  };
  stopReason?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

class BedrockConverseInteraction implements InteractionUtils {
  private request: BedrockConverseRequest;
  private response: BedrockConverseResponse;
  modelName: string;

  constructor(interaction: Interaction) {
    this.request = interaction.request as BedrockConverseRequest;
    this.response = interaction.response as BedrockConverseResponse;
    this.modelName = interaction.model ?? this.request.modelId;
  }

  isLastMessageToolCall(): boolean {
    const messages = this.request.messages;

    if (!messages || messages.length === 0) {
      return false;
    }

    const lastMessage = messages[messages.length - 1];

    // Check if last user message contains toolResult blocks
    if (lastMessage.role === "user" && Array.isArray(lastMessage.content)) {
      return lastMessage.content.some((block) => block.toolResult != null);
    }

    return false;
  }

  getLastToolCallId(): string | null {
    const messages = this.request.messages;
    if (!messages || messages.length === 0) {
      return null;
    }

    // Look for the last toolResult block in user messages
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "user" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.toolResult?.toolUseId) {
            return block.toolResult.toolUseId;
          }
        }
      }
    }

    return null;
  }

  getToolNamesUsed(): string[] {
    const toolsUsed = new Set<string>();
    const messages = this.request.messages;

    if (!messages) return [];

    // Tools are invoked by the assistant in toolUse blocks
    for (const message of messages) {
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.toolUse?.name) {
            toolsUsed.add(block.toolUse.name);
          }
        }
      }
    }

    return Array.from(toolsUsed);
  }

  getToolNamesRefused(): string[] {
    return [];
  }

  getToolNamesRequested(): string[] {
    const toolsRequested = new Set<string>();
    const responseContent = this.response.output?.message?.content;

    // Check the response for toolUse blocks (tools that LLM wants to execute)
    if (Array.isArray(responseContent)) {
      for (const block of responseContent) {
        if (block.toolUse?.name) {
          toolsRequested.add(block.toolUse.name);
        }
      }
    }

    return Array.from(toolsRequested);
  }

  getToolRefusedCount(): number {
    return 0;
  }

  getLastUserMessage(): string {
    const messages = this.request.messages;
    if (!messages) return "";

    const reversedMessages = [...messages].reverse();
    for (const message of reversedMessages) {
      if (message.role !== "user") {
        continue;
      }

      if (Array.isArray(message.content)) {
        // Find the first text block that's not a tool result
        for (const block of message.content) {
          if (block.text && !block.toolResult) {
            return block.text;
          }
        }
      }
    }
    return "";
  }

  getLastAssistantResponse(): string {
    const responseContent = this.response.output?.message?.content;

    if (!Array.isArray(responseContent)) {
      return "";
    }

    // Find the first text block in the response
    for (const block of responseContent) {
      if (block.text) {
        return block.text;
      }
    }

    return "";
  }

  private mapToUiMessage(
    message:
      | BedrockMessage
      | { role: "assistant"; content: BedrockResponseContentBlock[] },
    _dualLlmResults?: DualLlmResult[],
  ): PartialUIMessage {
    const parts: PartialUIMessage["parts"] = [];
    const { content, role } = message;

    if (!Array.isArray(content)) {
      return { role: role as PartialUIMessage["role"], parts };
    }

    // Process content blocks
    for (const block of content) {
      if (block.text) {
        parts.push({ type: "text", text: block.text });
      } else if (block.toolUse) {
        // Tool invocation by assistant
        parts.push({
          type: "dynamic-tool",
          toolName: block.toolUse.name,
          toolCallId: block.toolUse.toolUseId,
          state: "input-available",
          input: block.toolUse.input,
        });
      }
      // Note: toolResult blocks are handled in mapToUiMessages() where they're merged
    }

    return {
      role: role as PartialUIMessage["role"],
      parts,
    };
  }

  mapToUiMessages(dualLlmResults?: DualLlmResult[]): PartialUIMessage[] {
    const uiMessages: PartialUIMessage[] = [];
    const messages = this.request.messages;

    if (!messages) return uiMessages;

    // Track which user messages contain only toolResult blocks (to skip them later)
    const userMessagesWithToolResults = new Set<number>();

    // First pass: identify user messages that only contain toolResult blocks
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const hasOnlyToolResults = msg.content.every(
          (block) => block.toolResult != null,
        );
        if (hasOnlyToolResults && msg.content.length > 0) {
          userMessagesWithToolResults.add(i);
        }
      }
    }

    // Map request messages
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // Skip user messages that only contain tool results - they'll be merged with assistant
      if (userMessagesWithToolResults.has(i)) {
        continue;
      }

      const uiMessage = this.mapToUiMessage(msg, dualLlmResults);

      // If this is an assistant message with toolUse blocks, look ahead for tool results
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some((block) => block.toolUse != null);

        if (hasToolUse) {
          const toolCallParts: PartialUIMessage["parts"] = [...uiMessage.parts];

          // For each toolUse block, find its corresponding toolResult
          for (const block of msg.content) {
            if (block.toolUse) {
              // Look for the tool result in the next user message
              const toolResultMsg = messages
                .slice(i + 1)
                .find(
                  (m) =>
                    m.role === "user" &&
                    Array.isArray(m.content) &&
                    m.content.some(
                      (b) =>
                        b.toolResult?.toolUseId === block.toolUse?.toolUseId,
                    ),
                );

              if (toolResultMsg && Array.isArray(toolResultMsg.content)) {
                // Find the specific toolResult block
                const toolResultBlock = toolResultMsg.content.find(
                  (b) => b.toolResult?.toolUseId === block.toolUse?.toolUseId,
                );

                if (toolResultBlock?.toolResult) {
                  // Parse the tool result
                  let output: unknown;
                  try {
                    output =
                      typeof toolResultBlock.toolResult.content === "string"
                        ? JSON.parse(toolResultBlock.toolResult.content)
                        : toolResultBlock.toolResult.content;
                  } catch {
                    output = toolResultBlock.toolResult.content;
                  }

                  // Add tool result part
                  toolCallParts.push({
                    type: "dynamic-tool",
                    toolName: "tool-result",
                    toolCallId: block.toolUse.toolUseId,
                    state: "output-available",
                    input: {},
                    output,
                  });

                  // Check for dual LLM result
                  const dualLlmResultForTool = dualLlmResults?.find(
                    (result) => result.toolCallId === block.toolUse?.toolUseId,
                  );

                  if (dualLlmResultForTool) {
                    toolCallParts.push({
                      type: "dual-llm-analysis",
                      toolCallId: dualLlmResultForTool.toolCallId,
                      safeResult: dualLlmResultForTool.result,
                      conversations: Array.isArray(
                        dualLlmResultForTool.conversations,
                      )
                        ? (dualLlmResultForTool.conversations as Array<{
                            role: "user" | "assistant";
                            content: string | unknown;
                          }>)
                        : [],
                    });
                  }
                }
              }
            }
          }

          uiMessages.push({
            ...uiMessage,
            parts: toolCallParts,
          });
        } else {
          uiMessages.push(uiMessage);
        }
      } else {
        uiMessages.push(uiMessage);
      }
    }

    // Map response
    const responseContent = this.response.output?.message?.content;
    if (responseContent) {
      uiMessages.push(
        this.mapToUiMessage(
          { role: "assistant", content: responseContent },
          dualLlmResults,
        ),
      );
    }

    return uiMessages;
  }
}

export default BedrockConverseInteraction;
