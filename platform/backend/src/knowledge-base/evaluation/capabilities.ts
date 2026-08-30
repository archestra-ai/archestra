import type { ContextualRetrievalMode } from "@archestra/shared";
import config from "@/config";
import {
  type EmbeddingConfig,
  type OcrConfig,
  resolveEmbeddingConfig,
  resolveEmbeddingConfigForSettings,
  resolveOcrConfig,
  resolveOcrConfigForSettings,
  resolveRerankerConfig,
  resolveRerankerConfigForSettings,
} from "@/knowledge-base/kb-llm-client";
import OrganizationModel from "@/models/organization";
import type { RetrievalEvaluationSettingsOverrides } from "@/types/retrieval-evaluation";
import type { CapabilityState, EvalCapability } from "./schema";

type ResolvedReranker = Awaited<ReturnType<typeof resolveRerankerConfig>>;

export interface EvaluationContext {
  organizationId: string;
  organizationName: string;
  embedding: EmbeddingConfig | null;
  reranker: ResolvedReranker;
  ocr: OcrConfig | null;
  contextualRetrievalMode: ContextualRetrievalMode;
  capabilities: Record<EvalCapability, CapabilityState>;
  effectiveConfig: Record<string, string | number | boolean>;
  warnings: string[];
  errors: string[];
}

/** Resolve the same deployment and organization settings the live query path uses. */
export async function inspectEvaluationContext(
  organizationId: string,
  overrides: RetrievalEvaluationSettingsOverrides = {},
): Promise<EvaluationContext> {
  const organization = await OrganizationModel.getById(organizationId);
  if (!organization) {
    throw new Error(`organization not found: ${organizationId}`);
  }

  const warnings: string[] = [];
  const errors: string[] = [];
  let embedding: EmbeddingConfig | null = null;
  let reranker: ResolvedReranker = null;
  let ocr: OcrConfig | null = null;

  try {
    embedding = overrides.embedding
      ? await resolveEmbeddingConfigForSettings({
          organizationId,
          chatApiKeyId: overrides.embedding.chatApiKeyId,
          modelName: overrides.embedding.model,
          fallbackDimensions: organization.embeddingDimensions ?? 1536,
        })
      : await resolveEmbeddingConfig(organizationId);
  } catch (error) {
    errors.push(`embedding configuration is unavailable: ${summarize(error)}`);
  }
  try {
    reranker = overrides.reranker
      ? await resolveRerankerConfigForSettings({
          organizationId,
          chatApiKeyId: overrides.reranker.chatApiKeyId,
          modelName: overrides.reranker.model,
        })
      : await resolveRerankerConfig(organizationId);
  } catch (error) {
    warnings.push(`reranker configuration is unavailable: ${summarize(error)}`);
  }
  try {
    ocr = overrides.ocr
      ? await resolveOcrConfigForSettings({
          organizationId,
          chatApiKeyId: overrides.ocr.chatApiKeyId,
          modelName: overrides.ocr.model,
        })
      : await resolveOcrConfig(organizationId);
  } catch (error) {
    warnings.push(`OCR configuration is unavailable: ${summarize(error)}`);
  }

  const embeddingUnavailable = errors.find((error) =>
    error.startsWith("embedding configuration"),
  );
  const rerankerUnavailable = warnings.find((warning) =>
    warning.startsWith("reranker configuration"),
  );
  const ocrUnavailable = warnings.find((warning) =>
    warning.startsWith("OCR configuration"),
  );

  const textEmbedding = embedding
    ? active(
        `${embedding.provider}/${embedding.model} (${embedding.dimensions}d)`,
      )
    : embeddingUnavailable
      ? unavailable(embeddingUnavailable)
      : disabled("organization has no embedding credential and model pair");

  const imageEmbedding = embedding?.inputModalities?.includes("image")
    ? active(
        `${embedding.provider}/${embedding.model}; MIME types: ${embedding.acceptedImageMimeTypes?.join(", ") ?? "provider-defined"}`,
      )
    : embedding
      ? disabled(
          embedding.inputModalities === null
            ? "configured model has no declared image modality"
            : "configured embedding model is text-only",
        )
      : disabled("text embedding is not configured");

  const rerankerState = reranker
    ? active(`${reranker.provider}/${reranker.modelName} (${reranker.kind})`)
    : rerankerUnavailable
      ? unavailable(rerankerUnavailable)
      : disabled("organization has no reranker credential and model pair");
  const nativeReranker =
    reranker?.kind === "native-rerank"
      ? active(`${reranker.provider}/${reranker.modelName}`)
      : reranker
        ? disabled("configured reranker is an LLM, not a native cross-encoder")
        : disabled("no reranker is configured");
  const llmReranker =
    reranker?.kind === "llm"
      ? active(`${reranker.provider}/${reranker.modelName}`)
      : reranker
        ? disabled(
            "configured reranker is rerank-only and cannot generate text",
          )
        : disabled("no reranker is configured");

  const contextualRetrievalMode =
    overrides.contextualRetrievalMode ??
    organization.kbContextualRetrievalMode ??
    (config.kb.contextualRetrievalEnabled ? "document" : "disabled");
  const contextualRetrieval =
    contextualRetrievalMode === "disabled"
      ? disabled("contextual retrieval is disabled for this organization")
      : reranker?.kind === "llm"
        ? active(
            `${contextualRetrievalMode} mode using ${reranker.provider}/${reranker.modelName}`,
          )
        : unavailable(
            reranker
              ? "enabled, but the configured cross-encoder cannot generate document context"
              : "enabled, but no LLM reranker is configured",
          );

  const capabilities: Record<EvalCapability, CapabilityState> = {
    "text-embedding": textEmbedding,
    "image-embedding": imageEmbedding,
    ocr: ocr
      ? active(`${ocr.provider}/${ocr.modelName}`)
      : ocrUnavailable
        ? unavailable(ocrUnavailable)
        : disabled("organization has no OCR credential and model pair"),
    "hybrid-search": config.kb.hybridSearchEnabled
      ? active("vector and keyword lanes are enabled")
      : disabled("ARCHESTRA_KNOWLEDGE_BASE_HYBRID_SEARCH_ENABLED is false"),
    // The run updates this after refreshing and checking real corpus statistics.
    bm25: config.kb.hybridSearchEnabled
      ? unavailable("pending the real BM25 corpus-statistics refresh")
      : disabled("keyword search is disabled"),
    reranker: rerankerState,
    "cross-encoder-reranker": nativeReranker,
    "llm-reranker": llmReranker,
    "query-expansion": llmReranker,
    "contextual-retrieval": contextualRetrieval,
    "context-expansion":
      config.kb.contextExpansionRadius > 0
        ? active(`radius=${config.kb.contextExpansionRadius}`)
        : disabled("context expansion radius is 0"),
  };

  return {
    organizationId,
    organizationName: organization.name,
    embedding,
    reranker,
    ocr,
    contextualRetrievalMode,
    capabilities,
    effectiveConfig: {
      hybridSearchEnabled: config.kb.hybridSearchEnabled,
      chunkSizeTokens: config.kb.chunkSizeTokens,
      contextExpansionRadius: config.kb.contextExpansionRadius,
      contextualRetrievalEnabled: contextualRetrievalMode !== "disabled",
      contextualRetrievalMode,
      searchStatementTimeoutMillis: config.kb.searchStatementTimeoutMillis,
      bm25K1: organization.kbBm25K1 ?? config.kb.bm25K1,
      bm25B: organization.kbBm25B ?? config.kb.bm25B,
      bm25RecallCap: config.kb.bm25RecallCap,
      ocrMaxPagesPerDocument: config.kb.ocrMaxPagesPerDocument,
      embedding: embedding
        ? `${embedding.provider}/${embedding.model}`
        : "disabled",
      imageEmbedding: embedding?.inputModalities?.includes("image") ?? false,
      reranker: reranker
        ? `${reranker.provider}/${reranker.modelName} (${reranker.kind})`
        : "disabled",
      ocr: ocr ? `${ocr.provider}/${ocr.modelName}` : "disabled",
    },
    warnings,
    errors,
  };
}

export function applyEvaluationSettingsOverrides(params: {
  context: EvaluationContext;
  overrides: RetrievalEvaluationSettingsOverrides;
}): EvaluationContext {
  return {
    ...params.context,
    effectiveConfig: {
      ...params.context.effectiveConfig,
      bm25K1: params.overrides.bm25K1 ?? params.context.effectiveConfig.bm25K1,
      bm25B: params.overrides.bm25B ?? params.context.effectiveConfig.bm25B,
    },
  };
}

export function inactiveCapabilityReasons(
  requires: EvalCapability[],
  capabilities: Record<EvalCapability, CapabilityState>,
): string[] {
  return requires.flatMap((capability) => {
    const state = capabilities[capability];
    return state.status === "active"
      ? []
      : [`${capability}: ${state.status} (${state.detail})`];
  });
}

export function setCapability(
  context: EvaluationContext,
  capability: EvalCapability,
  state: CapabilityState,
): void {
  context.capabilities[capability] = state;
}

export function active(detail: string): CapabilityState {
  return { status: "active", detail };
}

export function unavailable(detail: string): CapabilityState {
  return { status: "unavailable", detail };
}

function disabled(detail: string): CapabilityState {
  return { status: "disabled", detail };
}

function summarize(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
