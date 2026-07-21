import { addNomicTaskPrefix } from "@archestra/shared";
import { generateObject } from "ai";
import { z } from "zod";
import { createDirectLLMModel } from "@/clients/llm-client";
import { callEmbedding } from "@/knowledge-base/embedding-clients";
import { toKnowledgeBaseUserMessage } from "@/knowledge-base/errors";
import { resolveApiKeyFromChatApiKey } from "@/knowledge-base/kb-llm-client";
import logger from "@/logging";
import { LlmProviderApiKeyModel, ModelModel } from "@/models";

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
      const llmModel = createDirectLLMModel({
        provider: resolved.provider,
        apiKey: resolved.apiKey ?? undefined,
        modelName: model,
        baseUrl: resolved.baseUrl,
      });
      // Exercise the exact capability reranking relies on: structured output.
      const result = await generateObject({
        model: llmModel,
        schema: RERANKER_VALIDATION_SCHEMA,
        prompt: RERANKER_VALIDATION_PROMPT,
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
      return {
        ok: false,
        error: `Failed to verify reranker model. Raw error: ${knowledgeValidationErrorMessage(error)}`,
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

// ===== Internal constants =====

const RERANKER_VALIDATION_SCHEMA = z.object({
  scores: z.array(z.object({ index: z.number(), score: z.number() })),
});

const RERANKER_VALIDATION_PROMPT =
  "You are a relevance scoring assistant. Score the passage from 0 to 10 for how " +
  "relevant it is to the query.\n\nQuery: hello\n\nPassages:\n[0] hello world\n\n" +
  "Return a score for the passage.";
