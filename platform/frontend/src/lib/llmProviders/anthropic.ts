import type { archestraApiTypes } from "@shared";
import type { PartialUIMessage } from "@/components/chatbot-demo";
import type { DualLlmResult, Interaction, InteractionUtils } from "./common";

class AnthropicMessagesInteraction implements InteractionUtils {
  private request: archestraApiTypes.AnthropicMessagesRequest;
  private response: archestraApiTypes.AnthropicMessagesResponse;
  modelName: string;

  constructor(interaction: Interaction) {
    this.request =
      interaction.request as archestraApiTypes.AnthropicMessagesRequest;
    this.response =
      interaction.response as archestraApiTypes.AnthropicMessagesResponse;
    this.modelName = interaction.model ?? this.request.model;
  }

  isLastMessageToolCall(): boolean {
    const messages = this.request.messages;

    if (messages.length === 0) {
      return false;
    }

    const lastMessage = messages[messages.length - 1];

    // Check if last user message contains tool_result blocks
    if (lastMessage.role === "user" && Array.isArray(lastMessage.content)) {
      return lastMessage.content.some((block) => block.type === "tool_result");
    }

    return false;
  }

  getLastToolCallId(): string | null {
    const messages = this.request.messages;
    if (messages.length === 0) {
      return null;
    }

    // Look for the last tool_result block in user messages
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "user" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "tool_result" && "tool_use_id" in block) {
            return block.tool_use_id;
          }
        }
      }
    }

    return null;
  }

  getToolNamesUsed(): string[] {
    const toolsUsed = new Set<string>();

    // Tools are invoked by the assistant in tool_use blocks
    for (const message of this.request.messages) {
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "tool_use" && "name" in block) {
            toolsUsed.add(block.name);
          }
        }
      }
    }

    return Array.from(toolsUsed);
  }

  getToolNamesRefused(): string[] {
    // TODO: Implement tool refusal detection for Anthropic if needed
    return [];
  }

  getToolNamesRequested(): string[] {
    const toolsRequested = new Set<string>();

    // Check the response for tool_use blocks (tools that LLM wants to execute)
    if (Array.isArray(this.response.content)) {
      for (const block of this.response.content) {
        if (block.type === "tool_use" && "name" in block) {
          toolsRequested.add(block.name);
        }
      }
    }

    return Array.from(toolsRequested);
  }

  getToolRefusedCount(): number {
    return 0;
  }

  getLastUserMessage(): string {
    const reversedMessages = [...this.request.messages].reverse();
    for (const message of reversedMessages) {
      if (message.role !== "user") {
        continue;
      }

      if (typeof message.content === "string") {
        return message.content;
      }

      if (Array.isArray(message.content)) {
        // Find the first text block that's not a tool_result
        for (const block of message.content) {
          if (block.type === "text" && "text" in block) {
            return block.text;
          }
        }
      }
    }
    return "";
  }

  getLastAssistantResponse(): string {
    const responseContent = this.response.content;

    if (!Array.isArray(responseContent)) {
      return "";
    }

    // Find the first text block in the response
    for (const block of responseContent) {
      if (block.type === "text" && "text" in block) {
        return block.text;
      }
    }

    return "";
  }

  private mapToUiMessage(
    message:
      | archestraApiTypes.AnthropicMessagesRequest["messages"][number]
      | {
          role: "assistant";
          content: archestraApiTypes.AnthropicMessagesResponse["content"];
        },
    _dualLlmResults?: DualLlmResult[],
  ): PartialUIMessage {
    const parts: PartialUIMessage["parts"] = [];
    const { content, role } = message;

    if (!Array.isArray(content)) {
      // String content (for user messages)
      if (typeof content === "string") {
        parts.push({ type: "text", text: content });
      }
      return { role: role as PartialUIMessage["role"], parts };
    }

    // Process content blocks
    for (const block of content) {
      if (block.type === "text" && "text" in block) {
        parts.push({ type: "text", text: block.text });
      } else if (
        block.type === "tool_use" &&
        "name" in block &&
        "id" in block
      ) {
        // Tool invocation by assistant
        parts.push({
          type: "dynamic-tool",
          toolName: block.name,
          toolCallId: block.id,
          state: "input-available",
          input: block.input,
        });
      }
      // Note: tool_result blocks are handled in mapToUiMessages() where they're merged
      // with their corresponding tool_use blocks, so we skip them here
    }

    return {
      role: role as PartialUIMessage["role"],
      parts,
    };
  }

  mapToUiMessages(dualLlmResults?: DualLlmResult[]): PartialUIMessage[] {
    const uiMessages: PartialUIMessage[] = [];
    const messages = this.request.messages;

    // Track which user messages contain tool_result blocks (to skip them later)
    const userMessagesWithToolResults = new Set<number>();

    // First pass: identify user messages that only contain tool_result blocks
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const hasOnlyToolResults = msg.content.every(
          (block) => block.type === "tool_result",
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

      // If this is an assistant message with tool_use blocks, look ahead for tool results
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some(
          (block) => block.type === "tool_use",
        );

        if (hasToolUse) {
          const toolCallParts: PartialUIMessage["parts"] = [...uiMessage.parts];

          // For each tool_use block, find its corresponding tool_result
          for (const block of msg.content) {
            if (block.type === "tool_use" && "id" in block) {
              // Look for the tool result in the next user message
              const toolResultMsg = messages
                .slice(i + 1)
                .find(
                  (m) =>
                    m.role === "user" &&
                    Array.isArray(m.content) &&
                    m.content.some(
                      (b) =>
                        b.type === "tool_result" &&
                        "tool_use_id" in b &&
                        b.tool_use_id === block.id,
                    ),
                );

              if (toolResultMsg && Array.isArray(toolResultMsg.content)) {
                // Find the specific tool_result block
                const toolResultBlock = toolResultMsg.content.find(
                  (b) =>
                    b.type === "tool_result" &&
                    "tool_use_id" in b &&
                    b.tool_use_id === block.id,
                );

                if (toolResultBlock && toolResultBlock.type === "tool_result") {
                  // Parse the tool result
                  let output: unknown;
                  try {
                    output =
                      typeof toolResultBlock.content === "string"
                        ? JSON.parse(toolResultBlock.content)
                        : toolResultBlock.content;
                  } catch {
                    output = toolResultBlock.content;
                  }

                  // Add tool result part
                  toolCallParts.push({
                    type: "dynamic-tool",
                    toolName: "tool-result",
                    toolCallId: block.id,
                    state: "output-available",
                    input: {},
                    output,
                  });

                  // Check for dual LLM result
                  const dualLlmResultForTool = dualLlmResults?.find(
                    (result) => result.toolCallId === block.id,
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
    uiMessages.push(
      this.mapToUiMessage(
        { role: "assistant", content: this.response.content },
        dualLlmResults,
      ),
    );

    return uiMessages;
  }
}

export default AnthropicMessagesInteraction;
