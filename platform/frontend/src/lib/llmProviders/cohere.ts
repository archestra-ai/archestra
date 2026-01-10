import type { archestraApiTypes } from "@shared";
import type { PartialUIMessage } from "@/components/chatbot-demo";
import type { DualLlmResult, Interaction, InteractionUtils } from "./common";

class CohereChatInteraction implements InteractionUtils {
  private request: archestraApiTypes.CohereChatRequest;
  private response: archestraApiTypes.CohereChatResponse;
  modelName: string;

  constructor(interaction: Interaction) {
    this.request =
      interaction.request as archestraApiTypes.CohereChatRequest;
    this.response =
      interaction.response as archestraApiTypes.CohereChatResponse;
    this.modelName = interaction.model ?? this.request.model;
  }

  isLastMessageToolCall(): boolean {
    const messages = this.request.messages;

    if (messages.length === 0) {
      return false;
    }

    const lastMessage = messages[messages.length - 1];

    // Check if last message is a tool message (tool result)
    return lastMessage.role === "tool";
  }

  getLastToolCallId(): string | null {
    const messages = this.request.messages;
    if (messages.length === 0) {
      return null;
    }

    // Look for the last tool message
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "tool" && "tool_call_id" in message) {
        return message.tool_call_id;
      }
    }

    return null;
  }

  getToolNamesUsed(): string[] {
    const toolsUsed = new Set<string>();

    // Tools are invoked by the assistant in tool_calls
    for (const message of this.request.messages) {
      if (message.role === "assistant" && "tool_calls" in message && message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          if (toolCall.type === "function" && toolCall.function?.name) {
            toolsUsed.add(toolCall.function.name);
          }
        }
      }
    }

    return Array.from(toolsUsed);
  }

  getToolNamesRefused(): string[] {
    // TODO: Implement tool refusal detection for Cohere if needed
    return [];
  }

  getToolNamesRequested(): string[] {
    const toolsRequested = new Set<string>();

    // Check the response for tool_calls (tools that LLM wants to execute)
    if (this.response.message?.tool_calls) {
      for (const toolCall of this.response.message.tool_calls) {
        if (toolCall.type === "function" && toolCall.function?.name) {
          toolsRequested.add(toolCall.function.name);
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
        // Find the first text block
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
    const responseContent = this.response.message?.content;

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
      | archestraApiTypes.CohereChatRequest["messages"][number]
      | {
          role: "assistant";
          content: archestraApiTypes.CohereChatResponse["message"]["content"];
          tool_calls?: archestraApiTypes.CohereChatResponse["message"]["tool_calls"];
        },
    _dualLlmResults?: DualLlmResult[],
  ): PartialUIMessage {
    const parts: PartialUIMessage["parts"] = [];
    const { role } = message;

    // Handle user messages
    if (role === "user") {
      const content = "content" in message ? message.content : undefined;
      if (typeof content === "string") {
        parts.push({ type: "text", text: content });
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && "text" in block) {
            parts.push({ type: "text", text: block.text });
          }
        }
      }
      return { role: "user", parts };
    }

    // Handle system messages
    if (role === "system") {
      const content = "content" in message ? message.content : "";
      if (typeof content === "string") {
        parts.push({ type: "text", text: content });
      }
      return { role: "assistant", parts }; // Map system to assistant for UI
    }

    // Handle tool messages (tool results)
    if (role === "tool") {
      // Skip tool messages as they'll be merged with assistant messages
      return { role: "user", parts };
    }

    // Handle assistant messages
    if (role === "assistant") {
      const content = "content" in message ? message.content : undefined;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && "text" in block) {
            parts.push({ type: "text", text: block.text });
          }
        }
      }

      // Handle tool calls
      const toolCalls = "tool_calls" in message ? message.tool_calls : undefined;
      if (toolCalls && Array.isArray(toolCalls)) {
        for (const toolCall of toolCalls) {
          if (toolCall.type === "function" && toolCall.function) {
            let input: unknown = {};
            try {
              input = JSON.parse(toolCall.function.arguments);
            } catch {
              input = { rawArguments: toolCall.function.arguments };
            }

            parts.push({
              type: "dynamic-tool",
              toolName: toolCall.function.name,
              toolCallId: toolCall.id,
              state: "input-available",
              input,
            });
          }
        }
      }
    }

    return {
      role: role as PartialUIMessage["role"],
      parts,
    };
  }

  mapToUiMessages(dualLlmResults?: DualLlmResult[]): PartialUIMessage[] {
    const uiMessages: PartialUIMessage[] = [];
    const messages = this.request.messages;

    // Track which messages are tool results (to skip them later)
    const toolResultIndices = new Set<number>();

    // First pass: identify tool result messages
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role === "tool") {
        toolResultIndices.add(i);
      }
    }

    // Map request messages
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // Skip tool result messages - they'll be merged with assistant
      if (toolResultIndices.has(i)) {
        continue;
      }

      const uiMessage = this.mapToUiMessage(msg, dualLlmResults);

      // If this is an assistant message with tool_calls, look ahead for tool results
      if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
        const toolCallParts: PartialUIMessage["parts"] = [...uiMessage.parts];

        // For each tool call, find its corresponding tool result
        for (const toolCall of msg.tool_calls) {
          if (toolCall.type !== "function") continue;

          // Look for the tool result in the following messages
          const toolResultMsg = messages
            .slice(i + 1)
            .find(
              (m) =>
                m.role === "tool" &&
                "tool_call_id" in m &&
                m.tool_call_id === toolCall.id,
            );

          if (toolResultMsg && "content" in toolResultMsg) {
            // Parse the tool result
            let output: unknown;
            try {
              output =
                typeof toolResultMsg.content === "string"
                  ? JSON.parse(toolResultMsg.content)
                  : toolResultMsg.content;
            } catch {
              output = toolResultMsg.content;
            }

            // Add tool result part
            toolCallParts.push({
              type: "dynamic-tool",
              toolName: "tool-result",
              toolCallId: toolCall.id,
              state: "output-available",
              input: {},
              output,
            });

            // Check for dual LLM result
            const dualLlmResultForTool = dualLlmResults?.find(
              (result) => result.toolCallId === toolCall.id,
            );

            if (dualLlmResultForTool) {
              toolCallParts.push({
                type: "dual-llm-analysis",
                toolCallId: dualLlmResultForTool.toolCallId,
                safeResult: dualLlmResultForTool.result,
                conversations: Array.isArray(dualLlmResultForTool.conversations)
                  ? (dualLlmResultForTool.conversations as Array<{
                      role: "user" | "assistant";
                      content: string | unknown;
                    }>)
                  : [],
              });
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
    }

    // Map response
    uiMessages.push(
      this.mapToUiMessage(
        {
          role: "assistant",
          content: this.response.message?.content,
          tool_calls: this.response.message?.tool_calls,
        },
        dualLlmResults,
      ),
    );

    return uiMessages;
  }
}

export default CohereChatInteraction;
