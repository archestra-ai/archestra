import type { SupportedProvider } from "@shared";
import type { PartialUIMessage } from "@/components/chatbot-demo";
import AnthropicMessagesInteraction from "./llmProviders/anthropic";
import CerebrasChatCompletionInteraction from "./llmProviders/cerebras";
import type {
  DualLlmResult,
  Interaction,
  InteractionUtils,
} from "./llmProviders/common";
import GeminiGenerateContentInteraction from "./llmProviders/gemini";
import OllamaChatCompletionInteraction from "./llmProviders/ollama";
import OpenAiChatCompletionInteraction from "./llmProviders/openai";
import VllmChatCompletionInteraction from "./llmProviders/vllm";

export interface CostSavingsInput {
  cost: string | null | undefined;
  baselineCost: string | null | undefined;
  toonCostSavings: string | null | undefined;
  toonTokensBefore: number | null | undefined;
  toonTokensAfter: number | null | undefined;
}

export interface CostSavingsResult {
  /** Savings from model optimization (baselineCost - cost) */
  costOptimizationSavings: number;
  /** Savings from TOON compression */
  toonSavings: number;
  /** Number of tokens saved by TOON compression */
  toonTokensSaved: number | null;
  /** Total savings (costOptimization + toon) */
  totalSavings: number;
  /** Baseline cost before any optimization */
  baselineCost: number;
  /** Actual cost after optimization */
  actualCost: number;
  /** Total savings as percentage of baseline */
  savingsPercent: number;
  /** Whether there are any savings at all */
  hasSavings: boolean;
}

/**
 * Calculate all cost savings from an interaction.
 * Used by both the logs table and detail view for consistent display.
 */
export function calculateCostSavings(
  input: CostSavingsInput,
): CostSavingsResult {
  const costNum = input.cost ? Number.parseFloat(input.cost) : 0;
  const baselineCostNum = input.baselineCost
    ? Number.parseFloat(input.baselineCost)
    : 0;
  const toonCostSavingsNum = input.toonCostSavings
    ? Number.parseFloat(input.toonCostSavings)
    : 0;

  // Calculate tokens saved from TOON compression
  const toonTokensSaved =
    input.toonTokensBefore &&
    input.toonTokensAfter &&
    input.toonTokensBefore > input.toonTokensAfter
      ? input.toonTokensBefore - input.toonTokensAfter
      : null;

  // Calculate cost optimization savings (from model selection)
  const costOptimizationSavings = baselineCostNum - costNum;

  // Calculate total savings
  const totalSavings = costOptimizationSavings + toonCostSavingsNum;

  // Calculate savings percentage
  const savingsPercent =
    baselineCostNum > 0 ? (totalSavings / baselineCostNum) * 100 : 0;

  return {
    costOptimizationSavings,
    toonSavings: toonCostSavingsNum,
    toonTokensSaved,
    totalSavings,
    baselineCost: baselineCostNum,
    actualCost: baselineCostNum - totalSavings,
    savingsPercent,
    hasSavings: totalSavings !== 0,
  };
}

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
    // Note: Type discriminator stored in database determines the interaction type
    const type = this.type as string;
    if (type === "openai:chatCompletions") {
      return new OpenAiChatCompletionInteraction(interaction);
    }
    if (type === "anthropic:messages") {
      return new AnthropicMessagesInteraction(interaction);
    }
    if (type === "cerebras:chatCompletions") {
      return new CerebrasChatCompletionInteraction(interaction);
    }
    if (type === "vllm:chatCompletions") {
      return new VllmChatCompletionInteraction(interaction);
    }
    if (type === "ollama:chatCompletions") {
      return new OllamaChatCompletionInteraction(interaction);
    }
    // Default to Gemini for any other provider
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
