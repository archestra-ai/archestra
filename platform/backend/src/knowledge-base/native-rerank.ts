import {
  getKnowledgeRerankerKind,
  type SupportedProvider,
} from "@archestra/shared";
import {
  getAzureOpenAiBearerTokenProvider,
  isAzureOpenAiEntraIdEnabled,
} from "@/clients/azure-openai-credentials";
import { normalizeAzureApiKey } from "@/clients/azure-url";

interface NativeRerankScore {
  index: number;
  /** Cohere relevance score, 0..1. */
  score: number;
}

/**
 * Whether a reranker model should be called through the provider's native
 * rerank API instead of the chat + structured-output path. Dedicated rerank
 * models (Cohere Rerank) serve only their own rerank route — the
 * chat-completions probe 404s — and the native route is what they are for.
 *
 * The shared capability contract prefers synced endpoint metadata and only
 * falls back to the legacy model-name signal when no endpoint metadata exists.
 * A provider/model pair qualifies only when Archestra implements its rerank
 * transport.
 */
export function isNativeRerankModel(params: {
  provider: SupportedProvider;
  model: string;
}): boolean {
  return getKnowledgeRerankerKind(params) === "native-rerank";
}

/**
 * Call the provider's native rerank API (Cohere v2 wire format) and return
 * per-document relevance scores.
 *
 * - `cohere` — `<base>/v2/rerank` on the Cohere API with bearer auth.
 * - `azure` — `<origin>/providers/cohere/v2/rerank`. Azure serves this route
 *   on every host alias of a Foundry resource (`*.cognitiveservices.azure.com`,
 *   `*.services.ai.azure.com`, `*.openai.azure.com`), so the origin of the
 *   key's configured base URL is enough; `model` must be the deployment name.
 */
export async function callNativeRerank(params: {
  provider: SupportedProvider;
  apiKey: string | null;
  baseUrl: string | null;
  model: string;
  query: string;
  documents: string[];
}): Promise<NativeRerankScore[]> {
  const { url, headers } = await buildRerankRequest(params);

  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: params.model,
      query: params.query,
      documents: params.documents,
    }),
  });

  if (!response.ok) {
    throw new NativeRerankError(
      response.status,
      await describeRerankFailure(response),
    );
  }

  const body = (await response.json()) as {
    results?: { index?: number; relevance_score?: number }[];
  };
  if (!Array.isArray(body.results)) {
    throw new NativeRerankError(
      502,
      "The rerank API returned no results array.",
    );
  }

  return body.results
    .filter(
      (r): r is { index: number; relevance_score: number } =>
        typeof r.index === "number" && typeof r.relevance_score === "number",
    )
    .map((r) => ({ index: r.index, score: r.relevance_score }));
}

// ===== Internal helpers =====

class NativeRerankError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "NativeRerankError";
  }
}

async function buildRerankRequest(params: {
  provider: SupportedProvider;
  apiKey: string | null;
  baseUrl: string | null;
}): Promise<{ url: string; headers: Record<string, string> }> {
  if (params.provider === "azure") {
    if (!params.baseUrl) {
      throw new NativeRerankError(
        400,
        "Azure AI Foundry base URL is required.",
      );
    }
    const origin = new URL(params.baseUrl).origin;
    const url = `${origin}/providers/cohere/v2/rerank`;
    const apiKey = normalizeAzureApiKey(params.apiKey ?? undefined);
    if (apiKey) {
      return { url, headers: { "api-key": apiKey } };
    }
    if (isAzureOpenAiEntraIdEnabled()) {
      const token = await getAzureOpenAiBearerTokenProvider(params.baseUrl)();
      return { url, headers: { Authorization: `Bearer ${token}` } };
    }
    throw new NativeRerankError(400, "Azure AI Foundry API key is required.");
  }

  if (!params.apiKey) {
    throw new NativeRerankError(400, "Cohere API key is required.");
  }
  // The configured Cohere base URL may carry a version segment; the v2 rerank
  // route lives at /v2/rerank on the API root.
  const base = (params.baseUrl || COHERE_DEFAULT_BASE_URL)
    .replace(/\/+$/, "")
    .replace(/\/v[12]$/, "");
  return {
    url: `${base}/v2/rerank`,
    headers: { Authorization: `Bearer ${params.apiKey}` },
  };
}

const COHERE_DEFAULT_BASE_URL = "https://api.cohere.com";

/** Rerank failures are surfaced to the settings UI; keep them short and readable. */
async function describeRerankFailure(response: Response): Promise<string> {
  const text = (await response.text().catch(() => "")).slice(0, 500);
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string };
      message?: string;
    };
    const message = parsed.error?.message ?? parsed.message;
    if (message) return message;
  } catch {
    // fall through to the raw body
  }
  return text || `Rerank request failed with HTTP ${response.status}.`;
}
