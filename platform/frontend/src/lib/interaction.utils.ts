import type { SupportedProvider } from "@shared";
import type { PartialUIMessage } from "@/components/chatbot-demo";
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
  private interaction: Interaction;

  id: string;
  profileId: string;
  externalAgentId: string | null;
  type: Interaction["type"];
  provider: SupportedProvider;
  endpoint: string;
  createdAt: string;
  modelName: string;

  constructor(interaction: Interaction) {
    const [provider, endpoint] = interaction.type.split(":");

    this.interaction = interaction;
    this.id = interaction.id;
    this.profileId = interaction.profileId;
    this.externalAgentId = interaction.externalAgentId;
    this.type = interaction.type;
    this.provider = provider as SupportedProvider;
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

  /**
   * Get TOON compression savings from database-stored token counts
   * Returns null if no TOON compression data available
   */
  getToonSavings(): {
    originalSize: number;
    compressedSize: number;
    savedCharacters: number;
    percentageSaved: number;
  } | null {
    const toonTokensBefore = this.interaction.toonTokensBefore;
    const toonTokensAfter = this.interaction.toonTokensAfter;

    // Return null if no TOON compression data
    if (
      toonTokensBefore === null ||
      toonTokensAfter === null ||
      toonTokensBefore === undefined ||
      toonTokensAfter === undefined
    ) {
      return null;
    }

    // Only show savings if there was actual compression
    if (toonTokensAfter >= toonTokensBefore || toonTokensBefore === 0) {
      return null;
    }

    const savedCharacters = toonTokensBefore - toonTokensAfter;
    const percentageSaved = (savedCharacters / toonTokensBefore) * 100;

    return {
      originalSize: toonTokensBefore,
      compressedSize: toonTokensAfter,
      savedCharacters,
      percentageSaved,
    };
  }
}
