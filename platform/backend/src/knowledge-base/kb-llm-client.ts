import type {
  ContextualRetrievalMode,
  EmbeddingModel,
  ModelInputModality,
  SupportedProvider,
} from "@archestra/shared";
import {
  getKnowledgeRerankerKind,
  isSubscriptionCredential,
  providerRequiresPerUserCredential,
} from "@archestra/shared";
import { createDirectLLMModel, type LLMModel } from "@/clients/llm-client";
import platformConfig, { getProviderConfiguredBaseUrl } from "@/config";
import logger from "@/logging";
import {
  LlmProviderApiKeyModel,
  ModelModel,
  OrganizationModel,
} from "@/models";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import {
  getEmbeddingClientAcceptedImageMimeTypes,
  getEmbeddingClientInputModalities,
} from "./embedding-clients";
import {
  EmbeddingConfigUnresolvableError,
  OcrConfigUnresolvableError,
  RerankerConfigUnresolvableError,
} from "./errors";
import { providerSupportsPdfInput } from "./pdf-ocr";

export interface EmbeddingConfig {
  /**
   * The provider secret, or `null` when the provider is keyless. `null` is a
   * meaningful value, not a placeholder: Bedrock IAM/IRSA keys are deliberately
   * secretless and must resolve to no key so the Bedrock client selects IAM auth
   * (a synthetic `"unused"` would force bearer auth and break IAM). Clients that
   * need a non-empty key string (OpenAI SDK) synthesize a local placeholder.
   */
  apiKey: string | null;
  baseUrl: string | null;
  model: EmbeddingModel;
  dimensions: number;
  provider: SupportedProvider;
  /** Input modalities supported by this embedding model (e.g. ["text", "image"]).
   * Null when no matching record exists in the models table (e.g. the model name
   * hasn't been synced from models.dev yet, or no model is configured). */
  inputModalities: ModelInputModality[] | null;
  /** Image MIME types the embedding client can send to this model, or null for
   * no per-format restriction. Only meaningful when `inputModalities` includes
   * "image"; connectors and the embedder skip images in other formats. */
  acceptedImageMimeTypes: string[] | null;
}

/**
 * Two reranker shapes: a chat LLM scored via structured output, or a dedicated
 * rerank-API model (Cohere Rerank, directly or Azure-hosted) called through
 * the provider's native rerank route.
 */
export type RerankerConfig = {
  modelName: string;
  provider: SupportedProvider;
} & (
  | { kind: "llm"; llmModel: LLMModel; baseUrl: string | null }
  | { kind: "native-rerank"; apiKey: string | null; baseUrl: string | null }
);

/** Resolved OCR transcription config: a vision-capable chat LLM. */
export interface OcrConfig {
  modelName: string;
  provider: SupportedProvider;
  llmModel: LLMModel;
}

/**
 * Resolve the embedding configuration for an organization.
 * Returns null if the organization doesn't have an embedding API key configured.
 */
export async function resolveEmbeddingConfig(
  organizationId: string,
): Promise<EmbeddingConfig | null> {
  const org = await OrganizationModel.getById(organizationId);
  if (!org?.embeddingChatApiKeyId || !org.embeddingModel) {
    return null;
  }

  return resolveEmbeddingConfigForSettings({
    organizationId,
    chatApiKeyId: org.embeddingChatApiKeyId,
    modelName: org.embeddingModel,
    fallbackDimensions: org.embeddingDimensions ?? 1536,
  });
}

export async function resolveEmbeddingConfigForSettings(params: {
  organizationId: string;
  chatApiKeyId: string;
  modelName: string;
  fallbackDimensions?: number;
}): Promise<EmbeddingConfig> {
  const resolved = await resolveOwnedApiKey(params);
  if (!resolved) {
    // Configured but unresolvable (e.g. a credential that won't decrypt) is a
    // real, diagnosable fault — distinct from "not configured" (null above).
    logger.warn(
      {
        organizationId: params.organizationId,
        chatApiKeyId: params.chatApiKeyId,
      },
      "[KB] Embedding API key configured but secret could not be resolved",
    );
    throw new EmbeddingConfigUnresolvableError();
  }

  const model = await ModelModel.findByProviderAndModelId(
    resolved.provider,
    params.modelName,
  );

  return {
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl,
    model: params.modelName,
    /**
     * TODO: Temporary transition. Prefer per-model dimensions. Fall back to the deprecated org-level
     * setting during the rollout, then to the historical 1536 default.
     */
    dimensions: model?.embeddingDimensions ?? params.fallbackDimensions ?? 1536,
    provider: resolved.provider,
    inputModalities: clampInputModalities({
      declared: model?.inputModalities ?? null,
      clientSupported: getEmbeddingClientInputModalities(
        resolved.provider,
        params.modelName,
      ),
    }),
    acceptedImageMimeTypes: getEmbeddingClientAcceptedImageMimeTypes(
      resolved.provider,
      params.modelName,
    ),
  };
}

/**
 * Resolve the reranker configuration for an organization.
 * Returns null if the organization doesn't have a reranker API key configured.
 */
export async function resolveRerankerConfig(
  organizationId: string,
): Promise<RerankerConfig | null> {
  const org = await OrganizationModel.getById(organizationId);
  if (!org?.rerankerChatApiKeyId || !org.rerankerModel) return null;

  return resolveRerankerConfigForSettings({
    organizationId,
    chatApiKeyId: org.rerankerChatApiKeyId,
    modelName: org.rerankerModel,
  });
}

/**
 * Resolve contextual retrieval's organization mode and chat model together.
 * Keeping this as one organization lookup matters during large connector runs:
 * the resolver is called once per changed document.
 */
export async function resolveContextualRetrievalConfig(
  organizationId: string,
): Promise<{
  mode: ContextualRetrievalMode;
  reranker: RerankerConfig | null;
}> {
  const org = await OrganizationModel.getById(organizationId);
  const mode =
    org?.kbContextualRetrievalMode ??
    (platformConfig.kb.contextualRetrievalEnabled ? "document" : "disabled");

  if (mode === "disabled" || !org?.rerankerChatApiKeyId || !org.rerankerModel) {
    return { mode, reranker: null };
  }

  return {
    mode,
    reranker: await resolveRerankerConfigForSettings({
      organizationId,
      chatApiKeyId: org.rerankerChatApiKeyId,
      modelName: org.rerankerModel,
    }),
  };
}

export async function resolveRerankerConfigForSettings(params: {
  organizationId: string;
  chatApiKeyId: string;
  modelName: string;
}): Promise<RerankerConfig> {
  const resolved = await resolveOwnedApiKey(params);
  if (!resolved) {
    // Configured but unresolvable. Reranking is optional and degrades at query
    // time, so the caller catches this and continues unranked — but it is still a
    // typed, surfaced fault (and blocks save).
    logger.warn(
      {
        organizationId: params.organizationId,
        chatApiKeyId: params.chatApiKeyId,
      },
      "[KB] Reranker API key configured but secret could not be resolved",
    );
    throw new RerankerConfigUnresolvableError();
  }

  const modelName = params.modelName;
  const modelRecord = await ModelModel.findByProviderAndModelId(
    resolved.provider,
    modelName,
  );
  const rerankerKind = getKnowledgeRerankerKind({
    provider: resolved.provider,
    model: modelName,
    embeddingDimensions: modelRecord?.embeddingDimensions,
    outputModalities: modelRecord?.outputModalities,
    supportedEndpoints: modelRecord?.supportedEndpoints,
  });
  if (!rerankerKind) {
    logger.warn(
      { provider: resolved.provider, model: modelName },
      "[KB] Configured model has no executable Knowledge reranking transport",
    );
    throw new RerankerConfigUnresolvableError();
  }

  if (rerankerKind === "native-rerank") {
    return {
      kind: "native-rerank",
      apiKey: resolved.apiKey,
      baseUrl: resolved.baseUrl,
      modelName,
      provider: resolved.provider,
    };
  }

  return {
    kind: "llm",
    baseUrl: resolved.baseUrl,
    llmModel: createDirectLLMModel({
      provider: resolved.provider,
      apiKey: resolved.apiKey ?? undefined,
      modelName,
      baseUrl: resolved.baseUrl,
    }),
    modelName,
    provider: resolved.provider,
  };
}

/**
 * Resolve the OCR transcription configuration for an organization.
 * Returns null when OCR is not configured — the pair of key + model is the
 * feature's only enable switch.
 */
export async function resolveOcrConfig(
  organizationId: string,
): Promise<OcrConfig | null> {
  const org = await OrganizationModel.getById(organizationId);
  if (!org?.ocrChatApiKeyId || !org.ocrModel) {
    return null;
  }

  return resolveOcrConfigForSettings({
    organizationId,
    chatApiKeyId: org.ocrChatApiKeyId,
    modelName: org.ocrModel,
  });
}

export async function resolveOcrConfigForSettings(params: {
  organizationId: string;
  chatApiKeyId: string;
  modelName: string;
}): Promise<OcrConfig> {
  const resolved = await resolveOwnedApiKey(params);
  if (!resolved) {
    // Configured but unresolvable (e.g. a credential that won't decrypt) is a
    // real, diagnosable fault — distinct from "not configured" (null above).
    // OCR is optional at ingest, so callers catch this and proceed without it.
    logger.warn(
      {
        organizationId: params.organizationId,
        chatApiKeyId: params.chatApiKeyId,
      },
      "[KB] OCR API key configured but secret could not be resolved",
    );
    throw new OcrConfigUnresolvableError();
  }

  // Save-time validation enforces this too, but the stored key's provider can
  // drift after save (or predate the check) — never trust modality metadata
  // for transport support.
  if (!providerSupportsPdfInput(resolved.provider)) {
    logger.warn(
      { organizationId: params.organizationId, provider: resolved.provider },
      "[KB] OCR key provider cannot carry PDF input",
    );
    throw new OcrConfigUnresolvableError(
      `The OCR credential's provider "${resolved.provider}" cannot accept PDF input. Reconfigure OCR with a supported provider, or clear it.`,
    );
  }

  return {
    modelName: params.modelName,
    provider: resolved.provider,
    llmModel: createDirectLLMModel({
      provider: resolved.provider,
      apiKey: resolved.apiKey ?? undefined,
      modelName: params.modelName,
      baseUrl: resolved.baseUrl,
    }),
  };
}

/**
 * Get the default organization and check if it has embedding configured.
 * Used by the embedding cron which runs without request context.
 */
export async function getDefaultOrgEmbeddingConfig(): Promise<{
  organizationId: string;
  config: EmbeddingConfig;
} | null> {
  const org = await OrganizationModel.getFirst();
  if (!org) return null;

  const embeddingConfig = await resolveEmbeddingConfig(org.id);
  if (!embeddingConfig) return null;

  return { organizationId: org.id, config: embeddingConfig };
}

/**
 * Resolve the actual API key, base URL, and provider from a chat API key ID.
 * Used by embedding config resolution and test-embedding endpoint.
 */
export async function resolveApiKeyFromChatApiKey(
  chatApiKeyId: string,
): Promise<{
  /** `null` when the provider is keyless (e.g. Ollama, Bedrock IAM). */
  apiKey: string | null;
  baseUrl: string | null;
  provider: SupportedProvider;
} | null> {
  const chatApiKey = await LlmProviderApiKeyModel.findById(chatApiKeyId);
  if (!chatApiKey) return null;

  // Knowledge-base embedding/reranking is a system operation with no acting
  // user, so a per-user provider (GitHub Copilot) can't be used here — its
  // token belongs to one person. (Copilot also exposes no embeddings.)
  if (providerRequiresPerUserCredential(chatApiKey.provider)) return null;

  // Fall back to the provider's configured (env-aware) base URL when none is set
  // on the key — the same source chat and model-sync use, so self-hosted
  // providers (Ollama/vLLM) resolve the deployment's host, not a hardcoded default.
  const baseUrl =
    chatApiKey.inferenceBaseUrl ||
    chatApiKey.baseUrl ||
    getProviderConfiguredBaseUrl(chatApiKey.provider) ||
    null;

  // Keyless providers (Ollama, Bedrock IAM) have no secret. Return `null` rather
  // than a placeholder so keyless-aware clients (Bedrock IAM) can distinguish "no
  // key" from a real key; clients that need a non-empty string synthesize their
  // own placeholder.
  if (!chatApiKey.secretId) {
    return {
      apiKey: null,
      baseUrl,
      provider: chatApiKey.provider,
    };
  }

  const apiKey = await getSecretValueForLlmProviderApiKey(chatApiKey.secretId);
  if (!apiKey) return null;

  // A subscription credential only works through the proxy adapter, which
  // decodes the marker and redeems a short-lived access token. KB
  // embedding/reranking calls the provider directly (no decode), so the raw
  // marker would be sent to the vendor's metered API as a bearer — leaking a
  // long-lived refresh token. Skip it, like the per-user guard above.
  if (isSubscriptionCredential(apiKey)) return null;

  return { apiKey, baseUrl, provider: chatApiKey.provider };
}

// ===== Internal helpers =====

async function resolveOwnedApiKey(params: {
  organizationId: string;
  chatApiKeyId: string;
}): Promise<Awaited<ReturnType<typeof resolveApiKeyFromChatApiKey>>> {
  const key = await LlmProviderApiKeyModel.findById(params.chatApiKeyId);
  if (!key || key.organizationId !== params.organizationId) return null;
  return resolveApiKeyFromChatApiKey(params.chatApiKeyId);
}

/**
 * Intersect the models table's (admin-editable) input modalities with what the
 * provider's embedding client can actually drive. Connectors gate image
 * ingestion on the resolved value, so this single intersection guarantees no
 * UI-reachable configuration makes them ingest images the embed call will
 * reject. A `null` client capability means "trust the table"; a `null` declared
 * list (no models row) stays `null`, which downstream treats as text-only.
 */
function clampInputModalities(params: {
  declared: ModelInputModality[] | null;
  clientSupported: ModelInputModality[] | null;
}): ModelInputModality[] | null {
  const { declared, clientSupported } = params;
  if (!declared || !clientSupported) {
    return declared;
  }
  return declared.filter((modality) => clientSupported.includes(modality));
}
