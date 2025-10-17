import type { PartialUIMessage } from "@/components/chatbot-demo";
import type { SupportedProviders } from "@/lib/clients/api";
import AnthropicMessagesInteraction from "./llmProviders/anthropic";
import type {
  DualLlmResult,
  Interaction,
  InteractionUtils,
} from "./llmProviders/common";
import GeminiGenerateContentInteraction from "./llmProviders/gemini";
import OpenAiChatCompletionInteraction from "./llmProviders/openai";

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
    } else if (this.type === "anthropic:messages") {
      return new AnthropicMessagesInteraction(interaction);
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

  getToolNamesRequested(): string[] {
    return this.interactionClass.getToolNamesRequested();
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
