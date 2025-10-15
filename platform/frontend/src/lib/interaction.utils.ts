import type { PartialUIMessage } from "@/components/chatbot-demo";
import type {
  GeminiGenerateContentRequest,
  GeminiGenerateContentResponse,
  GetDualLlmResultsByInteractionResponses,
  GetInteractionsResponses,
  OpenAiChatCompletionRequest,
  OpenAiChatCompletionResponse,
  SupportedProviders,
} from "@/lib/clients/api";

type Interaction = GetInteractionsResponses["200"]["data"][number];
type DualLlmResult = GetDualLlmResultsByInteractionResponses["200"][number];

export interface RefusalInfo {
  toolName?: string;
  toolArguments?: string;
  reason?: string;
}

interface InteractionUtils {
  modelName: string;

  /**
   * Check if the last message in an interaction is a tool message
   */
  isLastMessageToolCall(): boolean;

  /**
   * Get the tool_call_id from the last message if it's a tool message
   */
  getLastToolCallId(): string | null;

  /**
   * Get the names of the tools used in the interaction
   */
  getToolNamesUsed(): string[];

  getToolNamesRefused(): string[];

  getToolRefusedCount(): number;

  getLastUserMessage(): string;
  getLastAssistantResponse(): string;

  mapToUiMessages(dualLlmResults?: DualLlmResult[]): PartialUIMessage[];
}

function parseRefusalMessage(refusal: string): RefusalInfo {
  const toolNameMatch = refusal.match(
    /<archestra-tool-name>(.*?)<\/archestra-tool-name>/,
  );
  const toolArgsMatch = refusal.match(
    /<archestra-tool-arguments>(.*?)<\/archestra-tool-arguments>/,
  );
  const toolReasonMatch = refusal.match(
    /<archestra-tool-reason>(.*?)<\/archestra-tool-reason>/,
  );

  return {
    toolName: toolNameMatch?.[1],
    toolArguments: toolArgsMatch?.[1],
    reason: toolReasonMatch?.[1] || "Blocked by policy",
  };
}

class OpenAiChatCompletionInteraction implements InteractionUtils {
  private request: OpenAiChatCompletionRequest;
  private response: OpenAiChatCompletionResponse;
  modelName: string;

  constructor(interaction: Interaction) {
    this.request = interaction.request as OpenAiChatCompletionRequest;
    this.response = interaction.response as OpenAiChatCompletionResponse;
    this.modelName = this.request.model;
  }

  isLastMessageToolCall(): boolean {
    const messages = this.request.messages;

    if (messages.length === 0) {
      return false;
    }

    const lastMessage = messages[messages.length - 1];
    return lastMessage.role === "tool";
  }

  getLastToolCallId(): string | null {
    const messages = this.request.messages;
    if (messages.length === 0) {
      return null;
    }

    const lastMessage = messages[messages.length - 1];
    if (lastMessage.role === "tool") {
      return lastMessage.tool_call_id;
    }
    return null;
  }

  getToolNamesUsed(): string[] {
    const toolsUsed = new Set<string>();
    for (const message of this.request.messages) {
      if (message.role === "assistant" && message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          if ("function" in toolCall) {
            toolsUsed.add(toolCall.function.name);
          }
        }
      }
    }
    return Array.from(toolsUsed);
  }

  getToolNamesRefused(): string[] {
    const toolsRefused = new Set<string>();
    for (const message of this.request.messages) {
      if (message.role === "assistant") {
        /**
         * TODO: remove this as string assertion once we figure out the openapi/zod weirdness
         * (ie. there shouldn't be | unknown in the codegen'd type here..)
         */
        const refusal = message.refusal as string;
        if (refusal && refusal.length > 0) {
          const toolName = refusal.match(
            /<archestra-tool-name>(.*?)<\/archestra-tool-name>/,
          )?.[1];
          if (toolName) {
            toolsRefused.add(toolName);
          }
        }
      }
    }

    for (const message of this.response.choices) {
      /**
       * TODO: remove this as string assertion once we figure out the openapi/zod weirdness
       * (ie. there shouldn't be | unknown in the codegen'd type here..)
       */
      const refusal = message.message.refusal as string;
      if (refusal && refusal.length > 0) {
        const toolName = refusal.match(
          /<archestra-tool-name>(.*?)<\/archestra-tool-name>/,
        )?.[1];
        if (toolName) {
          toolsRefused.add(toolName);
        }
      }
    }
    return Array.from(toolsRefused);
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
      if (message.content?.[0]?.type === "text") {
        return message.content[0].text;
      }
    }
    return "";
  }

  getLastAssistantResponse(): string {
    /**
     * TODO: remove this as string assertion once we figure out the openapi/zod weirdness
     * (ie. there shouldn't be | unknown in the codegen'd type here..)
     */
    const content = this.response.choices[0]?.message?.content as string;
    return content ?? "";
  }

  getToolRefusedCount(): number {
    let count = 0;
    for (const message of this.request.messages) {
      if (message.role === "assistant") {
        /**
         * TODO: remove this as string assertion once we figure out the openapi/zod weirdness
         * (ie. there shouldn't be | unknown in the codegen'd type here..)
         */
        const refusal = message.refusal as string;
        if (refusal && refusal.length > 0) {
          count++;
        }
      }
    }
    for (const message of this.response.choices) {
      /**
       * TODO: remove this as string assertion once we figure out the openapi/zod weirdness
       * (ie. there shouldn't be | unknown in the codegen'd type here..)
       */
      const refusal = message.message.refusal as string;
      if (refusal && refusal.length > 0) {
        count++;
      }
    }
    return count;
  }

  private mapToUiMessage(
    message:
      | OpenAiChatCompletionRequest["messages"][number]
      | OpenAiChatCompletionResponse["choices"][number]["message"],
  ): PartialUIMessage {
    const parts: PartialUIMessage["parts"] = [];
    const { content, role } = message;

    if (role === "assistant") {
      const { tool_calls: toolCalls } = message;
      /**
       * TODO: remove this as string assertion once we figure out the openapi/zod weirdness
       * (ie. there shouldn't be | unknown in the codegen'd type here..)
       */
      const refusal = message.refusal as string;

      if (toolCalls) {
        // Handle assistant messages with tool calls

        // Add text content if present
        if (typeof content === "string" && content) {
          parts.push({ type: "text", text: content });
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (part.type === "text") {
              parts.push({ type: "text", text: part.text });
            } else if (part.type === "refusal") {
              parts.push({ type: "text", text: part.refusal });
            }
          }
        }

        // Add tool invocation parts
        if (toolCalls) {
          for (const toolCall of toolCalls) {
            if (toolCall.type === "function") {
              parts.push({
                type: "dynamic-tool",
                toolName: toolCall.function.name,
                toolCallId: toolCall.id,
                state: "input-available",
                input: JSON.parse(toolCall.function.arguments),
              });
            } else if (toolCall.type === "custom") {
              parts.push({
                type: "dynamic-tool",
                toolName: toolCall.custom.name,
                toolCallId: toolCall.id,
                state: "input-available",
                input: JSON.parse(toolCall.custom.input),
              });
            }
          }
        }
      } else if (refusal) {
        // Handle assistant messages with refusals (but no tool calls)

        // Parse the refusal message to extract tool information
        const refusalInfo = parseRefusalMessage(refusal);

        // Check if this is a tool invocation policy block
        if (refusalInfo.toolName) {
          // Create a special blocked tool part
          parts.push({
            type: "blocked-tool",
            toolName: refusalInfo.toolName,
            toolArguments: refusalInfo.toolArguments,
            reason: refusalInfo.reason || "Tool invocation blocked by policy",
            fullRefusal: refusal,
          });
        } else {
          // Regular refusal text
          parts.push({ type: "text", text: refusal });
        }
      }
    } else if (message.role === "tool") {
      // Handle tool response messages
      const toolContent = message.content;
      const toolCallId = message.tool_call_id;

      // Parse the tool output
      let output: unknown;
      try {
        output =
          typeof toolContent === "string"
            ? JSON.parse(toolContent)
            : toolContent;
      } catch {
        output = toolContent;
      }

      parts.push({
        type: "dynamic-tool",
        toolName: "tool-result",
        toolCallId,
        state: "output-available",
        input: {},
        output,
      });
    } else {
      // Handle regular content
      if (typeof content === "string") {
        parts.push({ type: "text", text: content });
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "text") {
            parts.push({ type: "text", text: part.text });
          } else if (part.type === "image_url") {
            parts.push({
              type: "file",
              mediaType: "image/*",
              url: part.image_url.url,
            });
          } else if (part.type === "refusal") {
            parts.push({ type: "text", text: part.refusal });
          }
          // Note: input_audio and file types from API would need additional handling
        }
      }
    }

    // Map role to UIMessage role (only system, user, assistant are allowed)
    const openAiRoleToUIMessageRoleMap: Record<
      OpenAiChatCompletionRequest["messages"][number]["role"],
      PartialUIMessage["role"]
    > = {
      developer: "system",
      system: "system",
      function: "assistant",
      tool: "assistant",
      user: "user",
      assistant: "assistant",
    };

    return {
      role: openAiRoleToUIMessageRoleMap[role],
      parts,
    };
  }

  private mapRequestToUiMessages(
    dualLlmResults?: DualLlmResult[],
  ): PartialUIMessage[] {
    const messages = this.request.messages;
    const uiMessages: PartialUIMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // Skip tool messages - they'll be merged with their assistant message
      if (msg.role === "tool") {
        continue;
      }

      const uiMessage = this.mapToUiMessage(msg);

      // If this is an assistant message with tool_calls, look ahead for tool results
      if (msg.role === "assistant" && "tool_calls" in msg && msg.tool_calls) {
        const toolCallParts: PartialUIMessage["parts"] = [...uiMessage.parts];

        // For each tool call, find its corresponding tool result
        for (const toolCall of msg.tool_calls) {
          // Find the tool result message
          const toolResultMsg = messages
            .slice(i + 1)
            .find(
              (m) =>
                m.role === "tool" &&
                "tool_call_id" in m &&
                m.tool_call_id === toolCall.id,
            );

          if (toolResultMsg && toolResultMsg.role === "tool") {
            // Map the tool result to a UI part
            const toolResultUiMsg = this.mapToUiMessage(toolResultMsg);
            toolCallParts.push(...toolResultUiMsg.parts);

            // Check if there's a dual LLM result for this tool call
            const dualLlmResultForTool = dualLlmResults?.find(
              (result) => result.toolCallId === toolCall.id,
            );

            if (dualLlmResultForTool) {
              const dualLlmPart = {
                type: "dual-llm-analysis" as const,
                toolCallId: dualLlmResultForTool.toolCallId,
                safeResult: dualLlmResultForTool.result,
                conversations: Array.isArray(dualLlmResultForTool.conversations)
                  ? (dualLlmResultForTool.conversations as Array<{
                      role: "user" | "assistant";
                      content: string | unknown;
                    }>)
                  : [],
              };
              toolCallParts.push(dualLlmPart);
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

    return uiMessages;
  }

  private mapResponseToUiMessages(): PartialUIMessage[] {
    return this.response.choices.map((choice) =>
      this.mapToUiMessage(choice.message),
    );
  }

  mapToUiMessages(dualLlmResults?: DualLlmResult[]): PartialUIMessage[] {
    return [
      ...this.mapRequestToUiMessages(dualLlmResults),
      ...this.mapResponseToUiMessages(),
    ];
  }
}

class GeminiGenerateContentInteraction implements InteractionUtils {
  private request: GeminiGenerateContentRequest;
  private response: GeminiGenerateContentResponse;
  modelName: string;

  constructor(interaction: Interaction) {
    this.request = interaction.request as GeminiGenerateContentRequest;
    this.response = interaction.response as GeminiGenerateContentResponse;
    this.modelName = this.response.modelVersion as string;
  }

  isLastMessageToolCall(): boolean {
    const messages = this.request.contents;

    if (messages.length === 0) {
      return false;
    }

    const lastMessage = messages[messages.length - 1];
    return lastMessage.role === "function";
  }

  // TODO: Implement this
  getLastToolCallId(): string | null {
    const messages = this.request.contents;
    if (messages.length === 0) {
      return null;
    }
    return null;
  }

  // TODO: Implement this
  getToolNamesUsed(): string[] {
    const messages = this.request.contents;
    if (messages.length === 0) {
      return [];
    }
    return [];
  }

  // TODO: Implement this
  getToolNamesRefused(): string[] {
    return [];
  }

  // TODO: Implement this
  getToolRefusedCount(): number {
    return 0;
  }

  // TODO: Implement this
  getLastUserMessage(): string {
    return "";
  }

  // TODO: Implement this
  getLastAssistantResponse(): string {
    return "";
  }

  // TODO: Implement this
  private mapToUiMessage(
    _content:
      | GeminiGenerateContentRequest["contents"][number]
      | GeminiGenerateContentResponse["candidates"][number],
  ): PartialUIMessage {
    return {
      role: "assistant",
      parts: [],
    };
  }

  private mapRequestToUiMessages(
    _dualLlmResults?: DualLlmResult[],
  ): PartialUIMessage[] {
    return this.request.contents.map((content) => this.mapToUiMessage(content));
  }

  private mapResponseToUiMessages(): PartialUIMessage[] {
    return (
      this.response?.candidates?.map((candidate) =>
        this.mapToUiMessage(candidate),
      ) ?? []
    );
  }

  mapToUiMessages(dualLlmResults?: DualLlmResult[]): PartialUIMessage[] {
    return [
      ...this.mapRequestToUiMessages(dualLlmResults),
      ...this.mapResponseToUiMessages(),
    ];
  }
}

export class DynamicInteraction implements InteractionUtils {
  private interactionClass: InteractionUtils;

  id: string;
  agentId: string;
  type: Interaction["type"];
  provider: SupportedProviders;
  endpoint: string;
  createdAt: string;
  modelName: string;

  constructor(interaction: Interaction) {
    const [provider, endpoint] = interaction.type.split(":");

    this.id = interaction.id;
    this.agentId = interaction.agentId;
    this.type = interaction.type;
    this.provider = provider as SupportedProviders;
    this.endpoint = endpoint;
    this.createdAt = interaction.createdAt;

    this.interactionClass = this.getInteractionClass(interaction);

    this.modelName = this.interactionClass.modelName;
  }

  private getInteractionClass(interaction: Interaction): InteractionUtils {
    if (this.type === "openai:chatCompletions") {
      return new OpenAiChatCompletionInteraction(interaction);
    }
    return new GeminiGenerateContentInteraction(interaction);
  }

  isLastMessageToolCall(): boolean {
    return this.interactionClass.isLastMessageToolCall();
  }

  getLastToolCallId(): string | null {
    return this.interactionClass.getLastToolCallId();
  }

  getToolNamesRefused(): string[] {
    return this.interactionClass.getToolNamesRefused();
  }

  getToolNamesUsed(): string[] {
    return this.interactionClass.getToolNamesUsed();
  }

  getToolRefusedCount(): number {
    return this.interactionClass.getToolRefusedCount();
  }

  getLastUserMessage(): string {
    return this.interactionClass.getLastUserMessage();
  }

  getLastAssistantResponse(): string {
    return this.interactionClass.getLastAssistantResponse();
  }

  /**
   * Map request messages, combining tool calls with their results and dual LLM analysis
   */
  mapToUiMessages(dualLlmResults?: DualLlmResult[]): PartialUIMessage[] {
    return this.interactionClass.mapToUiMessages(dualLlmResults);
  }
}
