import type {
  InteractionSource,
  SupportedProvider,
  SupportedProviderDiscriminator,
} from "@archestra/shared";
import type { Span } from "@opentelemetry/api";
import logger from "@/logging";
import { InteractionModel, ModelModel } from "@/models";
import { metrics } from "@/observability";
import {
  ATTR_ARCHESTRA_COST,
  ATTR_ARCHESTRA_TRIGGER_SOURCE,
  ATTR_GENAI_RESPONSE_MODEL,
  ATTR_GENAI_USAGE_INPUT_TOKENS,
  ATTR_GENAI_USAGE_OUTPUT_TOKENS,
} from "@/observability/tracing/attributes";
import { startActiveLlmSpan } from "@/observability/tracing/llm";
import type {
  GenAiOperationName,
  InteractionRequest,
  InteractionResponse,
} from "@/types";

/**
 * Maps a SupportedProvider to its default chat completion interaction type.
 * Used by the reranker since it uses chat completion APIs regardless of provider.
 */
export function getProviderChatInteractionType(
  provider: SupportedProvider,
): SupportedProviderDiscriminator {
  return PROVIDER_CHAT_INTERACTION_TYPE[provider];
}

interface KbInteractionData {
  request: unknown;
  response: unknown;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

interface KbObservabilityParams<T> {
  operationName: GenAiOperationName;
  provider: SupportedProvider;
  model: string;
  source: InteractionSource;
  type: SupportedProviderDiscriminator;
  callback: () => Promise<T>;
  /** Extract interaction data from a successful callback result. */
  buildInteraction: (result: T) => KbInteractionData;
}

/**
 * Wraps a knowledge base LLM call with OTEL tracing and interaction recording.
 *
 * - Creates an OTEL span covering the callback execution (captures latency)
 * - Records an interaction via InteractionModel.create on success (fire-and-forget)
 * - On callback error: span is set to ERROR, no interaction recorded, error re-thrown
 */
export async function withKbObservability<T>(
  params: KbObservabilityParams<T>,
): Promise<T> {
  return startActiveLlmSpan({
    operationName: params.operationName,
    provider: params.provider,
    model: params.model,
    stream: false,
    callback: async (span: Span) => {
      span.setAttribute(ATTR_ARCHESTRA_TRIGGER_SOURCE, params.source);

      const startTime = Date.now();
      const result = await params.callback();
      const durationSeconds = (Date.now() - startTime) / 1000;
      const interaction = params.buildInteraction(result);

      span.setAttribute(ATTR_GENAI_RESPONSE_MODEL, interaction.model);
      span.setAttribute(ATTR_GENAI_USAGE_INPUT_TOKENS, interaction.inputTokens);
      span.setAttribute(
        ATTR_GENAI_USAGE_OUTPUT_TOKENS,
        interaction.outputTokens,
      );

      const cost = await calculateKbCost({
        model: interaction.model,
        provider: params.provider,
        inputTokens: interaction.inputTokens,
        outputTokens: interaction.outputTokens,
      });

      if (cost !== undefined) {
        span.setAttribute(ATTR_ARCHESTRA_COST, cost);
      }

      metrics.llm.reportKbLlmCall({
        provider: params.provider,
        model: interaction.model,
        inputTokens: interaction.inputTokens,
        outputTokens: interaction.outputTokens,
        durationSeconds,
        cost,
        source: params.source,
      });

      InteractionModel.create({
        profileId: null,
        source: params.source,
        type: params.type,
        request: interaction.request as InteractionRequest,
        response: interaction.response as InteractionResponse,
        model: interaction.model,
        inputTokens: interaction.inputTokens,
        outputTokens: interaction.outputTokens,
        cost: cost?.toFixed(10) ?? null,
      }).catch((error) => {
        logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          `[KB] Failed to record ${params.source} interaction`,
        );
      });

      return result;
    },
  });
}

/**
 * Builds interaction data for an embedding API call.
 * Strips embedding vectors from the stored response to save space.
 */
export function buildEmbeddingInteraction(params: {
  model: string;
  input: string | string[];
  dimensions: number;
  response: {
    object: string;
    data: Array<{ object: string; embedding: number[]; index: number }>;
    model: string;
    usage: { prompt_tokens: number; total_tokens: number };
  };
}): KbInteractionData {
  const { response } = params;
  return {
    request: {
      model: params.model,
      input: params.input,
      dimensions: params.dimensions,
    },
    response: {
      object: response.object,
      // Store a short, self-describing preview of each vector (the first few
      // values) rather than an empty array, so a successful embed and a
      // degenerate one no longer look identical in the logs. `truncatedFrom`
      // records the full length so it clearly reads as a sample. Only the logged
      // copy is truncated — storage and search use the full vector — and an empty
      // vector stays empty (no marker).
      data: response.data.map((d) => {
        const preview = d.embedding.slice(0, EMBEDDING_LOG_PREVIEW_LENGTH);
        return {
          object: d.object,
          embedding: preview,
          index: d.index,
          ...(d.embedding.length > preview.length
            ? { truncatedFrom: d.embedding.length }
            : {}),
        };
      }),
      model: response.model,
      usage: response.usage,
    },
    model: response.model,
    inputTokens: response.usage.prompt_tokens,
    outputTokens: 0,
  };
}

// ===== Internal helpers =====

async function calculateKbCost(params: {
  model: string;
  provider: SupportedProvider;
  inputTokens: number;
  outputTokens: number;
}): Promise<number | undefined> {
  try {
    const modelEntry = await ModelModel.findByProviderAndModelId(
      params.provider,
      params.model,
    );
    const pricing = ModelModel.getEffectivePricing(modelEntry, params.model);
    const inputCost =
      (params.inputTokens / 1_000_000) *
      Number.parseFloat(pricing.pricePerMillionInput);
    const outputCost =
      (params.outputTokens / 1_000_000) *
      Number.parseFloat(pricing.pricePerMillionOutput);
    return inputCost + outputCost;
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "[KB] Failed to calculate cost",
    );
    return undefined;
  }
}

// ===== Internal constants =====

/** How many leading vector values to keep in the logged embedding preview. */
const EMBEDDING_LOG_PREVIEW_LENGTH = 8;

const PROVIDER_CHAT_INTERACTION_TYPE: Record<
  SupportedProvider,
  SupportedProviderDiscriminator
> = {
  openai: "openai:chatCompletions",
  archestra: "archestra:chatCompletions",
  gemini: "gemini:generateContent",
  anthropic: "anthropic:messages",
  bedrock: "bedrock:converse",
  cohere: "cohere:chat",
  cerebras: "cerebras:chatCompletions",
  mistral: "mistral:chatCompletions",
  perplexity: "perplexity:chatCompletions",
  groq: "groq:chatCompletions",
  xai: "xai:chatCompletions",
  openrouter: "openrouter:chatCompletions",
  vllm: "vllm:chatCompletions",
  ollama: "ollama:chatCompletions",
  zhipuai: "zhipuai:chatCompletions",
  deepseek: "deepseek:chatCompletions",
  minimax: "minimax:chatCompletions",
  kimi: "kimi:chatCompletions",
  azure: "azure:chatCompletions",
  "github-copilot": "github-copilot:chatCompletions",
  "microsoft-365-copilot": "microsoft-365-copilot:chatCompletions",
};
