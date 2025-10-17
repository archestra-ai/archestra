import type { PartialUIMessage } from "@/components/chatbot-demo";
import type {
  AnthropicMessagesRequest,
  AnthropicMessagesResponse,
} from "@/lib/clients/api";
import type { DualLlmResult, Interaction, InteractionUtils } from "./common";

class AnthropicMessagesInteraction implements InteractionUtils {
  private request: AnthropicMessagesRequest;
  private response: AnthropicMessagesResponse;
  modelName: string;

  constructor(interaction: Interaction) {
    this.request = interaction.request as AnthropicMessagesRequest;
    this.response = interaction.response as AnthropicMessagesResponse;
    this.modelName = this.request.model;
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
      | AnthropicMessagesRequest["messages"][number]
      | { role: "assistant"; content: AnthropicMessagesResponse["content"] },
    dualLlmResults?: DualLlmResult[],
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
      } else if (block.type === "tool_result" && "tool_use_id" in block) {
        // Tool result from user
        let output: unknown;
        try {
          output =
            typeof block.content === "string"
              ? JSON.parse(block.content)
              : block.content;
        } catch {
          output = block.content;
        }

        parts.push({
          type: "dynamic-tool",
          toolName: "tool-result",
          toolCallId: block.tool_use_id,
          state: "output-available",
          input: {},
          output,
        });

        // Check if there's a dual LLM result for this tool call
        const dualLlmResultForTool = dualLlmResults?.find(
          (result) => result.toolCallId === block.tool_use_id,
        );

        if (dualLlmResultForTool) {
          parts.push({
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

    return {
      role: role as PartialUIMessage["role"],
      parts,
    };
  }

  mapToUiMessages(dualLlmResults?: DualLlmResult[]): PartialUIMessage[] {
    const uiMessages: PartialUIMessage[] = [];

    // Map request messages
    for (const message of this.request.messages) {
      uiMessages.push(this.mapToUiMessage(message, dualLlmResults));
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
