import type { SupportedProvider } from "../index";
import AnthropicMessagesInteraction from "./llmProviders/anthropic";
import AzureChatCompletionInteraction from "./llmProviders/azure";
import AzureResponsesInteraction from "./llmProviders/azure-responses";
import BedrockConverseInteraction from "./llmProviders/bedrock";
import CerebrasChatCompletionInteraction from "./llmProviders/cerebras";
import CohereChatInteraction from "./llmProviders/cohere";
import type {
  DualLlmAnalysis,
  Interaction,
  InteractionUtils,
} from "./llmProviders/common";
import DeepSeekChatCompletionInteraction from "./llmProviders/deepseek";
import GeminiGenerateContentInteraction from "./llmProviders/gemini";
import GithubCopilotChatCompletionInteraction from "./llmProviders/github-copilot";
import GroqChatCompletionInteraction from "./llmProviders/groq";
import MinimaxChatCompletionInteraction from "./llmProviders/minimax";
import MistralChatCompletionInteraction from "./llmProviders/mistral";
import OllamaChatCompletionInteraction from "./llmProviders/ollama";
import OpenAiChatCompletionInteraction from "./llmProviders/openai";
import OpenAiEmbeddingInteraction from "./llmProviders/openai-embedding";
import OpenAiResponsesInteraction from "./llmProviders/openai-responses";
import OpenrouterChatCompletionInteraction from "./llmProviders/openrouter";
import PerplexityChatCompletionInteraction from "./llmProviders/perplexity";
import VllmChatCompletionInteraction from "./llmProviders/vllm";
import XaiChatCompletionInteraction from "./llmProviders/xai";
import ZhipuaiChatCompletionInteraction from "./llmProviders/zhipuai";
import type { PartialUIMessage } from "./types";

type InteractionFactory = (interaction: Interaction) => InteractionUtils;

const interactionFactories: Record<Interaction["type"], InteractionFactory> = {
  "openai:chatCompletions": (i) => new OpenAiChatCompletionInteraction(i),
  "openai:responses": (i) => new OpenAiResponsesInteraction(i),
  "openai:embeddings": (i) => new OpenAiEmbeddingInteraction(i),
  // Gemini embeddings use the OpenAI-compatible embedding shape.
  "gemini:embeddings": (i) => new OpenAiEmbeddingInteraction(i),
  "openrouter:chatCompletions": (i) =>
    new OpenrouterChatCompletionInteraction(i),
  "anthropic:messages": (i) => new AnthropicMessagesInteraction(i),
  "bedrock:converse": (i) => new BedrockConverseInteraction(i),
  "cerebras:chatCompletions": (i) => new CerebrasChatCompletionInteraction(i),
  "cohere:chat": (i) => new CohereChatInteraction(i),
  "gemini:generateContent": (i) => new GeminiGenerateContentInteraction(i),
  "mistral:chatCompletions": (i) => new MistralChatCompletionInteraction(i),
  "ollama:chatCompletions": (i) => new OllamaChatCompletionInteraction(i),
  "perplexity:chatCompletions": (i) =>
    new PerplexityChatCompletionInteraction(i),
  "vllm:chatCompletions": (i) => new VllmChatCompletionInteraction(i),
  "zhipuai:chatCompletions": (i) => new ZhipuaiChatCompletionInteraction(i),
  "deepseek:chatCompletions": (i) => new DeepSeekChatCompletionInteraction(i),
  "github-copilot:chatCompletions": (i) =>
    new GithubCopilotChatCompletionInteraction(i),
  "groq:chatCompletions": (i) => new GroqChatCompletionInteraction(i),
  "xai:chatCompletions": (i) => new XaiChatCompletionInteraction(i),
  "minimax:chatCompletions": (i) => new MinimaxChatCompletionInteraction(i),
  "azure:chatCompletions": (i) => new AzureChatCompletionInteraction(i),
  "azure:responses": (i) => new AzureResponsesInteraction(i),
};

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
  /**
   * Estimated cost: what the request would have cost without the optimizations
   * we attribute (original model + uncompressed tool results). Equals
   * `actualCost + totalSavings`.
   */
  estimatedCost: number;
  /** Actual cost charged — the stored `cost`, already reflecting every optimization */
  actualCost: number;
  /** Total savings as a percentage of the estimated cost (0–100) */
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

  // `cost` is the real spend. It already reflects every applied optimization
  // (the cheaper model and TOON's reduced billed token count), so it is the
  // true actual cost. It must never be re-derived by subtracting savings again
  // — doing so double-counts the TOON savings already baked into `cost` and can
  // produce a negative cost and a >100% savings percentage.
  const actualCost = costNum;

  // Savings from model selection: identical token usage priced at the original
  // model vs. the model actually used.
  const costOptimizationSavings = baselineCostNum - costNum;

  // Total savings (model optimization + TOON compression).
  const totalSavings = costOptimizationSavings + toonCostSavingsNum;

  // The estimated (non-optimized) cost sits exactly `totalSavings` above the
  // real spend, so the breakdown always reconciles and the percentage stays
  // within 0–100% for any non-negative savings.
  const estimatedCost = actualCost + totalSavings;

  const savingsPercent =
    estimatedCost > 0 ? (totalSavings / estimatedCost) * 100 : 0;

  return {
    costOptimizationSavings,
    toonSavings: toonCostSavingsNum,
    toonTokensSaved,
    totalSavings,
    estimatedCost,
    actualCost,
    savingsPercent,
    hasSavings: totalSavings !== 0,
  };
}

export class DynamicInteraction implements InteractionUtils {
  private interactionClass: InteractionUtils;
  private interaction: Interaction;

  id: string;
  profileId: string | null;
  externalAgentId: string | null;
  executionId: string | null;
  unsafeContextBoundary: Interaction["unsafeContextBoundary"];
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
    this.executionId = interaction.executionId;
    this.unsafeContextBoundary = interaction.unsafeContextBoundary;
    this.type = interaction.type;
    this.provider = provider as SupportedProvider;
    this.endpoint = endpoint;
    this.createdAt = interaction.createdAt;

    this.interactionClass = this.getInteractionClass(interaction);

    this.modelName = this.interactionClass.modelName;
  }

  private getInteractionClass(interaction: Interaction): InteractionUtils {
    const factory =
      interactionFactories[this.type as keyof typeof interactionFactories];
    if (!factory) {
      throw new Error(`Unsupported interaction type: ${this.type}`);
    }
    return factory(interaction);
  }

  /**
   * A failed interaction is persisted with the provider `type` but a
   * `{ error }` response instead of a provider response. Returns that error
   * string, or null when the response is a normal provider response.
   */
  private getErrorResponseText(): string | null {
    const response: unknown = this.interaction.response;
    if (
      response !== null &&
      typeof response === "object" &&
      "error" in response &&
      typeof (response as { error: unknown }).error === "string"
    ) {
      return (response as { error: string }).error;
    }
    return null;
  }

  isLastMessageToolCall(): boolean {
    return this.interactionClass.isLastMessageToolCall();
  }

  getLastToolCallId(): string | null {
    return this.interactionClass.getLastToolCallId();
  }

  getToolNamesRefused(): string[] {
    if (this.getErrorResponseText() !== null) {
      return [];
    }
    return this.interactionClass.getToolNamesRefused();
  }

  getToolNamesRequested(): string[] {
    if (this.getErrorResponseText() !== null) {
      return [];
    }
    return this.interactionClass.getToolNamesRequested();
  }

  getToolNamesUsed(): string[] {
    if (this.getErrorResponseText() !== null) {
      return [];
    }
    return this.interactionClass.getToolNamesUsed();
  }

  getToolRefusedCount(): number {
    if (this.getErrorResponseText() !== null) {
      return 0;
    }
    return this.interactionClass.getToolRefusedCount();
  }

  getLastUserMessage(): string {
    return this.interactionClass.getLastUserMessage();
  }

  getLastAssistantResponse(): string {
    const errorText = this.getErrorResponseText();
    if (errorText !== null) {
      return errorText;
    }
    return this.interactionClass.getLastAssistantResponse();
  }

  /**
   * Map request messages, combining tool calls with their results and dual LLM analysis
   */
  mapToUiMessages(dualLlmAnalyses?: DualLlmAnalysis[]): PartialUIMessage[] {
    const errorText = this.getErrorResponseText();
    if (errorText === null) {
      return this.interactionClass.mapToUiMessages(dualLlmAnalyses);
    }
    // Failed interaction: the response is `{ error }`, not a provider response.
    // Recover the request side when the provider mapper tolerates the missing
    // response fields, then surface the error as the assistant turn.
    let messages: PartialUIMessage[] = [];
    try {
      messages = this.interactionClass.mapToUiMessages(dualLlmAnalyses);
    } catch {
      messages = [];
    }
    return [
      ...messages,
      {
        id: `${this.id}-error`,
        role: "assistant",
        parts: [{ type: "text", text: errorText }],
      },
    ];
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
