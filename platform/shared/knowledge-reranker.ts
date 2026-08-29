import type {
  SupportedProvider,
  SupportedProviderEndpoint,
} from "./model-constants";

export type KnowledgeRerankerKind = "llm" | "native-rerank";

export function getKnowledgeRerankerKind(params: {
  provider: SupportedProvider;
  model: string;
  embeddingDimensions?: number | null;
  outputModalities?: string[] | null;
  supportedEndpoints?: SupportedProviderEndpoint[] | null;
}): KnowledgeRerankerKind | null {
  if (params.embeddingDimensions != null) return null;
  if (params.outputModalities && !params.outputModalities.includes("text")) {
    return null;
  }

  const endpoints = params.supportedEndpoints ?? [];
  const advertisesRerank = endpoints.includes("/rerank");
  const legacyDedicatedReranker =
    endpoints.length === 0 && /rerank/i.test(params.model);
  if (advertisesRerank || legacyDedicatedReranker) {
    return NATIVE_RERANK_PROVIDERS.has(params.provider)
      ? "native-rerank"
      : null;
  }

  if (
    endpoints.length > 0 &&
    !endpoints.includes("/chat/completions") &&
    !endpoints.includes("/responses")
  ) {
    return null;
  }
  return "llm";
}

const NATIVE_RERANK_PROVIDERS: ReadonlySet<SupportedProvider> = new Set([
  "cohere",
  "azure",
]);
