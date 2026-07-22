import type {
  SupportedProvider,
  SupportedProviderDiscriminator,
} from "@archestra/shared";
import { callAzureEmbedding } from "./azure";
import { callBedrockEmbedding } from "./bedrock";
import { callGeminiEmbedding } from "./gemini";
import { callOpenAIEmbedding } from "./openai";
import type { EmbeddingApiResponse, EmbeddingInput } from "./types";

type EmbeddingCall = (params: {
  inputs: EmbeddingInput[];
  model: string;
  apiKey: string | null;
  baseUrl?: string | null;
  dimensions?: number;
}) => Promise<EmbeddingApiResponse>;

interface EmbeddingAdapter {
  call: EmbeddingCall;
  discriminator: SupportedProviderDiscriminator;
}

/**
 * Keyless configs (Ollama, Azure Entra ID, Vertex AI) historically resolved to
 * the literal placeholder "unused", which every client except Bedrock treats as
 * "no key". Only Bedrock must distinguish a genuinely-absent key (→ IAM/IRSA
 * auth), so it alone receives `null`; all other clients keep their `string` key
 * contract via this placeholder.
 */
const KEYLESS_PLACEHOLDER = "unused";

// `const` is not hoisted, so the shared adapters are declared before the
// registry that references them.
const OPENAI_WIRE: EmbeddingAdapter = {
  call: withPlaceholderKey(callOpenAIEmbedding),
  discriminator: "openai:embeddings",
};

// Ollama/Mistral/vLLM serve a fixed native dimension and reject the OpenAI
// `dimensions` truncation parameter, so drop it before the call.
const OPENAI_WIRE_FIXED_DIMENSION: EmbeddingAdapter = {
  call: withPlaceholderKey(callOpenAIEmbedding, { dropDimensions: true }),
  discriminator: "openai:embeddings",
};

/**
 * Which embedding client (if any) each provider uses.
 *
 * A `null` entry means the provider genuinely has no embedding path and must be
 * rejected — never silently sent to the OpenAI-compatible client (spec item 2).
 * The allowlist is verified against provider documentation and this repo's own
 * proxy embedding routes, not assumed:
 *   - native: gemini (own SDK), azure (Azure OpenAI), bedrock (Amazon Titan);
 *   - OpenAI-compatible /v1/embeddings: openai, openrouter, zhipuai, ollama,
 *     mistral, vllm;
 *   - everything else → null.
 *
 * The registry encodes adapter behavior (which client, which discriminator,
 * whether the `dimensions` parameter is honored), not a mere yes/no. It is an
 * exhaustive `Record`, so adding a new `SupportedProvider` is a compile error
 * here until its embedding support is decided.
 */
export const EMBEDDING_ADAPTERS: Record<
  SupportedProvider,
  EmbeddingAdapter | null
> = {
  // Native embedding clients.
  gemini: {
    call: withPlaceholderKey(callGeminiEmbedding),
    discriminator: "gemini:embeddings",
  },
  azure: {
    call: withPlaceholderKey(callAzureEmbedding),
    discriminator: "openai:embeddings",
  },
  // Bedrock is the only client that accepts a nullable key: `null` selects
  // IAM/IRSA auth rather than a bearer placeholder.
  bedrock: { call: callBedrockEmbedding, discriminator: "bedrock:embeddings" },

  // OpenAI-compatible, honor the `dimensions` parameter.
  openai: OPENAI_WIRE,
  openrouter: OPENAI_WIRE,
  zhipuai: OPENAI_WIRE,

  // OpenAI-compatible, fixed native dimension — drop `dimensions`.
  ollama: OPENAI_WIRE_FIXED_DIMENSION,
  mistral: OPENAI_WIRE_FIXED_DIMENSION,
  vllm: OPENAI_WIRE_FIXED_DIMENSION,

  // No embedding support — reject (they error/crash on the OpenAI path today).
  anthropic: null,
  cohere: null,
  cerebras: null,
  deepseek: null,
  groq: null,
  perplexity: null,
  xai: null,
  minimax: null,
  kimi: null,
  "github-copilot": null,
  "microsoft-365-copilot": null,
  // Chat-only integration; embeddings are not wired for the Archestra provider.
  archestra: null,
};

// ===== Internal helpers =====

/**
 * Adapt a client that requires a key string into an `EmbeddingCall` (nullable
 * key), substituting the keyless placeholder — and optionally dropping the
 * `dimensions` parameter for providers that reject it.
 */
function withPlaceholderKey(
  call: (params: {
    inputs: EmbeddingInput[];
    model: string;
    apiKey: string;
    baseUrl?: string | null;
    dimensions?: number;
  }) => Promise<EmbeddingApiResponse>,
  opts?: { dropDimensions?: boolean },
): EmbeddingCall {
  return (params) =>
    call({
      ...params,
      apiKey: params.apiKey ?? KEYLESS_PLACEHOLDER,
      ...(opts?.dropDimensions ? { dimensions: undefined } : {}),
    });
}
