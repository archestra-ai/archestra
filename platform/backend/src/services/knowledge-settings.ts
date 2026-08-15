import { addNomicTaskPrefix } from "@archestra/shared";
import { generateObject, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import { createDirectLLMModel } from "@/clients/llm-client";
import { callEmbedding } from "@/knowledge-base/embedding-clients";
import { toKnowledgeBaseUserMessage } from "@/knowledge-base/errors";
import { resolveApiKeyFromChatApiKey } from "@/knowledge-base/kb-llm-client";
import {
  callNativeRerank,
  isNativeRerankModel,
} from "@/knowledge-base/native-rerank";
import { RERANKER_OUTPUT_CONTRACT } from "@/knowledge-base/reranker";
import logger from "@/logging";
import { LlmProviderApiKeyModel, ModelModel } from "@/models";
import { repairStructuredOutputText } from "@/utils/structured-output-repair";

interface KnowledgeConfigValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Validates Knowledge-settings configurations by actually exercising them (a real
 * embedding call, a real structured-output reranker call) — not merely confirming
 * fields are filled in. Used by the save route (to block an invalid save) and the
 * standalone connection test.
 */
class KnowledgeSettingsService {
  async validateEmbeddingConfig(params: {
    keyId: string;
    model: string;
    organizationId: string;
  }): Promise<KnowledgeConfigValidationResult> {
    const { keyId, model, organizationId } = params;

    const chatApiKey = await LlmProviderApiKeyModel.findById(keyId);
    // Scope the key to the caller's org: the id arrives from the request body,
    // so an unscoped lookup would let a caller probe (and spend) another org's
    // credential by id.
    if (!chatApiKey || chatApiKey.organizationId !== organizationId) {
      return { ok: false, error: "The embedding API key could not be found." };
    }

    const resolved = await resolveApiKeyFromChatApiKey(keyId);
    if (!resolved) {
      return {
        ok: false,
        error: "The embedding API key could not be resolved. Reconfigure it.",
      };
    }

    const modelRow = await ModelModel.findByProviderAndModelId(
      resolved.provider,
      model,
    );
    if (!modelRow?.embeddingDimensions) {
      return {
        ok: false,
        error:
          "The selected model is not marked as an embedding model with configured dimensions in LLM Providers > Models.",
      };
    }

    try {
      const response = await callEmbedding({
        inputs: [addNomicTaskPrefix(model, "hello world", "search_document")],
        model,
        apiKey: resolved.apiKey,
        baseUrl: resolved.baseUrl,
        dimensions: modelRow.embeddingDimensions,
        provider: resolved.provider,
      });
      if (response.data.length > 0) {
        return { ok: true };
      }
      return {
        ok: false,
        error: "The embedding provider returned no embedding data.",
      };
    } catch (error) {
      logger.error(
        { err: error },
        "[KnowledgeSettings] Embedding validation failed",
      );
      return {
        ok: false,
        error: `Failed to verify embedding model. Raw error: ${knowledgeValidationErrorMessage(error)}`,
      };
    }
  }

  async validateRerankerConfig(params: {
    keyId: string;
    model: string;
    organizationId: string;
  }): Promise<KnowledgeConfigValidationResult> {
    const { keyId, model, organizationId } = params;

    const chatApiKey = await LlmProviderApiKeyModel.findById(keyId);
    // Scope the key to the caller's org (see validateEmbeddingConfig).
    if (!chatApiKey || chatApiKey.organizationId !== organizationId) {
      return { ok: false, error: "The reranker API key could not be found." };
    }

    const resolved = await resolveApiKeyFromChatApiKey(keyId);
    if (!resolved) {
      return {
        ok: false,
        error: "The reranker API key could not be resolved. Reconfigure it.",
      };
    }

    try {
      // Dedicated rerank models are exercised through the provider's native
      // rerank route; everything else through the chat + structured-output
      // capability reranking relies on.
      if (isNativeRerankModel({ provider: resolved.provider, model })) {
        const scores = await callNativeRerank({
          provider: resolved.provider,
          apiKey: resolved.apiKey,
          baseUrl: resolved.baseUrl,
          model,
          query: "hello",
          documents: ["hello world"],
        });
        if (scores.length > 0) {
          return { ok: true };
        }
        return {
          ok: false,
          error: "The rerank API returned no relevance scores.",
        };
      }

      const llmModel = createDirectLLMModel({
        provider: resolved.provider,
        apiKey: resolved.apiKey ?? undefined,
        modelName: model,
        baseUrl: resolved.baseUrl,
      });
      const result = await generateObject({
        model: llmModel,
        schema: RERANKER_VALIDATION_SCHEMA,
        prompt: RERANKER_VALIDATION_PROMPT,
        experimental_repairText: repairStructuredOutputText,
      });
      if (Array.isArray(result.object?.scores)) {
        return { ok: true };
      }
      return {
        ok: false,
        error: "The reranker model did not return structured scores.",
      };
    } catch (error) {
      logger.error(
        { err: error },
        "[KnowledgeSettings] Reranker validation failed",
      );
      // A rerank-named model on a provider with no native rerank surface went
      // through the chat-completions probe, which such deployments reject with
      // an unhelpful raw error — explain the mismatch when the name gives it
      // away. Checked first: a wrong kind of model is a more specific (and more
      // actionable) diagnosis than whatever it answered with.
      const rerankApiHint =
        /rerank/i.test(model) &&
        !isNativeRerankModel({ provider: resolved.provider, model })
          ? " — this looks like a dedicated rerank-API model, which is supported with Cohere and Azure AI Foundry keys. With this provider, select a chat model instead."
          : "";
      // The model answered — it just didn't answer with an object. That is a
      // structured-output problem, not a connectivity or credential one, so it
      // gets its own explanation rather than the raw-error wrapper below.
      if (!rerankApiHint && NoObjectGeneratedError.isInstance(error)) {
        return { ok: false, error: unstructuredRerankerResponseMessage(error) };
      }
      return {
        ok: false,
        error: `Failed to verify reranker model. Raw error: ${knowledgeValidationErrorMessage(error)}${rerankApiHint}`,
      };
    }
  }
}

export const knowledgeSettingsService = new KnowledgeSettingsService();

// ===== Internal helpers =====

function knowledgeValidationErrorMessage(error: unknown): string {
  return (
    toKnowledgeBaseUserMessage(error) ??
    (error instanceof Error ? error.message : "Unknown error")
  );
}

/**
 * The model answered, but not with an object reranking can read — the repair
 * pass could not find one either. Worth its own message: the raw AI SDK text
 * ("No object generated: could not parse the response.") names neither the
 * cause nor the fix, and the fix is a property of the deployment rather than of
 * the credential or the model name.
 */
function unstructuredRerankerResponseMessage(
  error: NoObjectGeneratedError,
): string {
  return (
    "The reranker model replied, but not with the JSON object reranking needs. " +
    "Models that wrap their answer in reasoning tokens, prose, or markdown fences do this when the " +
    "endpoint does not constrain decoding to the requested JSON schema. Enable guided/structured " +
    "decoding (JSON schema) on the endpoint, or pick a model that supports structured outputs." +
    responseExcerpt(error.text)
  );
}

/**
 * A short, quoted piece of the model's reply, so an admin can tell a reasoning
 * preamble from a refusal without reading server logs. Safe to surface: the
 * probe prompt is a fixed synthetic passage, so the reply carries no
 * organization content.
 */
function responseExcerpt(text: string | undefined): string {
  const collapsed = text?.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  const clipped =
    collapsed.length > RESPONSE_EXCERPT_MAX_LENGTH
      ? `${collapsed.slice(0, RESPONSE_EXCERPT_MAX_LENGTH)}…`
      : collapsed;
  return ` The model replied: "${clipped}"`;
}

// ===== Internal constants =====

const RERANKER_VALIDATION_SCHEMA = z.object({
  scores: z.array(z.object({ index: z.number(), score: z.number() })),
});

const RERANKER_VALIDATION_PROMPT =
  "You are a relevance scoring assistant. Score the passage from 0 to 10 for how " +
  "relevant it is to the query.\n\nQuery: hello\n\nPassages:\n[0] hello world\n\n" +
  `Return a score for the passage.\n\n${RERANKER_OUTPUT_CONTRACT}`;

const RESPONSE_EXCERPT_MAX_LENGTH = 200;
