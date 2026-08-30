import {
  addNomicTaskPrefix,
  getKnowledgeRerankerKind,
} from "@archestra/shared";
import { generateObject, generateText, NoObjectGeneratedError } from "ai";
import { z } from "zod";
import { createDirectLLMModel } from "@/clients/llm-client";
import { callEmbedding } from "@/knowledge-base/embedding-clients";
import { toKnowledgeBaseUserMessage } from "@/knowledge-base/errors";
import { resolveApiKeyFromChatApiKey } from "@/knowledge-base/kb-llm-client";
import {
  callNativeRerank,
  isNativeRerankModel,
} from "@/knowledge-base/native-rerank";
import { providerSupportsPdfInput } from "@/knowledge-base/pdf-ocr";
import { RERANKER_OUTPUT_CONTRACT } from "@/knowledge-base/reranker-prompt";
import logger from "@/logging";
import {
  KbChunkModel,
  LlmProviderApiKeyModel,
  ModelModel,
  TaskModel,
} from "@/models";
import type { KeywordRankingStatus } from "@/types";
import { repairStructuredOutputText } from "@/utils/structured-output-repair";

interface KnowledgeConfigValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Validates Knowledge-settings configurations by actually exercising them (a real
 * embedding call, a real structured-output reranker call) — not merely confirming
 * fields are filled in. Used by the save route (to block an invalid save) and the
 * standalone connection test. Also reports where BM25 keyword ranking stands
 * for the settings page.
 */
class KnowledgeSettingsService {
  /**
   * Where BM25 keyword ranking stands for an organization: whether statistics
   * cover every language it has documents in (else keyword search ranks that
   * language with `ts_rank`), and the refresh task's last success, next run,
   * whether one is in flight, and its latest failure.
   */
  async getKeywordRankingStatus(
    organizationId: string,
  ): Promise<KeywordRankingStatus> {
    const [coverage, indexedAnything, refresh] = await Promise.all([
      KbChunkModel.getBm25StatsCoverage(organizationId),
      KbChunkModel.hasIndexedChunks(organizationId),
      TaskModel.getPeriodicTaskStatus("kb_bm25_stats_refresh"),
    ]);
    // Degraded exactly where the query gate degrades: a language holding
    // chunks whose statistics are not built yet. A language with nothing
    // indexed never gets statistics from `ts_stat`, so counting it would
    // pin the page at "building" forever while searches rank with BM25.
    const degraded = coverage.some(
      (language) => language.hasChunks && !language.hasStats,
    );
    // `coverage` is empty when no live connector remains, which is also when
    // no search can reach the organization's chunks — reporting "ready" there
    // would describe ranking that never runs.
    const searchable = indexedAnything && coverage.length > 0;
    const status = !searchable
      ? "no_documents"
      : degraded
        ? "pending"
        : "ready";
    return {
      status,
      lastRefreshedAt: refresh.lastSucceededAt?.toISOString() ?? null,
      nextRefreshAt: refresh.nextRunAt?.toISOString() ?? null,
      refreshing: refresh.running,
      lastRefreshFailed: refresh.lastAttemptError !== null,
    };
  }

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
    const modelRecord = await ModelModel.findByProviderAndModelId(
      resolved.provider,
      model,
    );
    const rerankerKind = getKnowledgeRerankerKind({
      provider: resolved.provider,
      model,
      embeddingDimensions: modelRecord?.embeddingDimensions,
      outputModalities: modelRecord?.outputModalities,
      supportedEndpoints: modelRecord?.supportedEndpoints,
    });
    if (!rerankerKind) {
      return {
        ok: false,
        error:
          "This provider and model cannot be used for Knowledge reranking. Select a model listed for this API key.",
      };
    }

    try {
      // Dedicated rerank models are exercised through the provider's native
      // rerank route; everything else through the chat + structured-output
      // capability reranking relies on.
      if (rerankerKind === "native-rerank") {
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

  /**
   * Validate an OCR pair by actually sending a PDF: transport support is a
   * property of the provider adapter AND the endpoint's model, so the only
   * trustworthy check is a real file-part call. The probe document is a tiny
   * synthetic page built here — no organization content is sent.
   */
  async validateOcrConfig(params: {
    keyId: string;
    model: string;
    organizationId: string;
  }): Promise<KnowledgeConfigValidationResult> {
    const { keyId, model, organizationId } = params;

    const chatApiKey = await LlmProviderApiKeyModel.findById(keyId);
    // Scope the key to the caller's org (see validateEmbeddingConfig).
    if (!chatApiKey || chatApiKey.organizationId !== organizationId) {
      return { ok: false, error: "The OCR API key could not be found." };
    }

    const resolved = await resolveApiKeyFromChatApiKey(keyId);
    if (!resolved) {
      return {
        ok: false,
        error: "The OCR API key could not be resolved. Reconfigure it.",
      };
    }

    if (!providerSupportsPdfInput(resolved.provider)) {
      return {
        ok: false,
        error: `The provider "${resolved.provider}" cannot send PDF pages to a model, so it cannot back OCR. Use an Anthropic, OpenAI, Gemini, Bedrock, Azure, OpenRouter, or vLLM key.`,
      };
    }

    const modelRow = await ModelModel.findByProviderAndModelId(
      resolved.provider,
      model,
    );
    // Modality metadata is advisory (custom endpoints often have no models
    // row); when it exists and rules out documents AND images, fail before
    // spending a probe call on a text-only model.
    if (
      modelRow?.inputModalities &&
      !modelRow.inputModalities.includes("pdf") &&
      !modelRow.inputModalities.includes("image")
    ) {
      return {
        ok: false,
        error:
          "The selected model is text-only (per LLM Providers > Models) — OCR needs a model that accepts PDF or image input.",
      };
    }

    try {
      const llmModel = createDirectLLMModel({
        provider: resolved.provider,
        apiKey: resolved.apiKey ?? undefined,
        modelName: model,
        baseUrl: resolved.baseUrl,
      });
      // Success is the call being accepted end to end (transport serialized
      // the file part, the endpoint took it, the model answered) — the reply's
      // wording is irrelevant.
      await generateText({
        model: llmModel,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "This is a document-input capability check. Reply with the single word OK.",
              },
              {
                type: "file",
                data: buildOcrProbePdf(),
                mediaType: "application/pdf",
              },
            ],
          },
        ],
        maxOutputTokens: 64,
        maxRetries: 1,
        abortSignal: AbortSignal.timeout(OCR_PROBE_TIMEOUT_MS),
      });
      return { ok: true };
    } catch (error) {
      logger.error({ err: error }, "[KnowledgeSettings] OCR validation failed");
      return {
        ok: false,
        error: `Failed to verify the OCR model with a PDF page. Raw error: ${knowledgeValidationErrorMessage(error)}`,
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
  const excerpt = responseExcerpt(error.text);
  if (!excerpt) {
    // The SDK saw no text at all. A reasoning model that spends its whole
    // output budget thinking lands here, and no decoding setting fixes that.
    return "The reranker model returned no text to score with. This usually means a reasoning model spent its whole output budget thinking; pick a model that answers directly.";
  }
  return (
    "The reranker model replied, but not with the JSON object reranking needs. " +
    "Models that wrap their answer in reasoning tokens, prose, or markdown fences do this when the " +
    "endpoint does not constrain decoding to the requested JSON schema. Enable guided/structured " +
    `decoding (JSON schema) on the endpoint, or pick a model that supports structured outputs.${excerpt}`
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

/**
 * A minimal one-page classic-xref PDF ("DOCUMENT INPUT PROBE") built from a
 * template. Constructed in code rather than shipped as an asset so the
 * production bundle needs no fixture file.
 */
function buildOcrProbePdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
  ];
  const stream = "BT /F1 14 Tf 30 60 Td (DOCUMENT INPUT PROBE) Tj ET";
  objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, obj] of objects.entries()) {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const xrefStart = body.length;
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`)
    .join("")}`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(body + xref + trailer, "latin1");
}

const OCR_PROBE_TIMEOUT_MS = 30_000;
