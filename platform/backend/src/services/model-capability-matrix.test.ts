import type { SupportedProvider } from "@archestra/shared";
import type { ModelsDevApiResponse } from "@/clients/models-dev-client";
import { ModelModel } from "@/models";
import type { FetchedModelCapabilities } from "@/routes/chat/model-fetchers/types";
import { describe, expect, test } from "@/test";
import type {
  ModelInputModality,
  ModelOutputModality,
  PriceSource,
} from "@/types";
import { resolveDiscoveredModelRegistryEntry } from "./cross-provider-pricing";
import { enrichDiscoveredModel } from "./discovered-model-enrichment";
import { buildModelsToUpsert } from "./model-sync";
import { lookupOpenAiPublishedPrices } from "./openai-published-pricing";

/**
 * Black-box matrix over model metadata resolution: given a provider, a model id
 * as the provider's own endpoint reports it, and a models.dev snapshot, what
 * price and capabilities does the API end up serving?
 *
 * Each row exercises a resolution path no other row does — id shape, source
 * tier, or fallback — so adding a model that resolves like an existing one adds
 * maintenance without signal. Add a row when it covers a new path, or to pin a
 * model that caused a production incident.
 *
 * Expected values are hand-written from each vendor's published pricing, never
 * read back out of MODELS_DEV: expectations derived from the fixture would pass
 * even if resolution were completely broken.
 */

/**
 * Hand-built models.dev snapshot mirroring the real registry's shapes. Entries
 * are transcribed from live models.dev data; models the real registry has
 * retired (Claude 3 Sonnet, Llama 3.2, Titan embeddings) are omitted here too,
 * which is what drives the `default`-priced rows below.
 *
 * `ollama` is absent on purpose — models.dev has no ollama provider entry, so
 * local models can only ever resolve from the fetcher plus hardcoded inference.
 */
const MODELS_DEV: ModelsDevApiResponse = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-4o": {
        id: "gpt-4o",
        name: "GPT-4o",
        cost: { input: 2.5, output: 10, cache_read: 1.25 },
        limit: { context: 128000, output: 16384 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        tool_call: true,
      },
      "gpt-4o-mini": {
        id: "gpt-4o-mini",
        name: "GPT-4o mini",
        cost: { input: 0.15, output: 0.6, cache_read: 0.075 },
        limit: { context: 128000, output: 16384 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        tool_call: true,
      },
      "gpt-4.1-nano": {
        id: "gpt-4.1-nano",
        name: "GPT-4.1 nano",
        cost: { input: 0.1, output: 0.4, cache_read: 0.025 },
        limit: { context: 1047576, output: 32768 },
        modalities: { input: ["text", "image"], output: ["text"] },
        tool_call: true,
      },
      "gpt-5.4": {
        id: "gpt-5.4",
        name: "GPT-5.4",
        cost: { input: 2.5, output: 15, cache_read: 0.25 },
        limit: { context: 1050000, output: 128000 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        tool_call: true,
      },
      // Present so the `gpt-3.5-turbo-0125` row proves the 4-digit suffix is
      // deliberately NOT stripped, rather than passing because nothing matches.
      "gpt-3.5-turbo": {
        id: "gpt-3.5-turbo",
        name: "GPT-3.5 Turbo",
        cost: { input: 0.5, output: 1.5, cache_read: 0 },
        limit: { context: 16385, output: 4096 },
        modalities: { input: ["text"], output: ["text"] },
        tool_call: false,
      },
      "text-embedding-3-small": {
        id: "text-embedding-3-small",
        name: "text-embedding-3-small",
        cost: { input: 0.02, output: 0 },
        limit: { context: 8191, output: 1536 },
        modalities: { input: ["text"], output: ["text"] },
        tool_call: false,
      },
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-opus-4-8": {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
        limit: { context: 1000000, output: 128000 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        tool_call: true,
      },
      // The vendor entry claims a 1M window; the amazon-bedrock entry below
      // says 200K for the same model. Bedrock's is the truthful one there.
      "claude-sonnet-4-5": {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        limit: { context: 1000000, output: 64000 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        tool_call: true,
      },
      "claude-haiku-4-5": {
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        cost: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
        limit: { context: 200000, output: 64000 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        tool_call: true,
      },
    },
  },
  "amazon-bedrock": {
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    models: {
      // Same prices as the vendor entry, but a smaller (correct) window.
      "anthropic.claude-sonnet-4-5-20250929-v1:0": {
        id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
        name: "Claude Sonnet 4.5",
        cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
        limit: { context: 200000, output: 64000 },
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        tool_call: true,
      },
      // No canonical vendor entry exists for Amazon's own models.
      "amazon.nova-lite-v1:0": {
        id: "amazon.nova-lite-v1:0",
        name: "Nova Lite",
        cost: { input: 0.06, output: 0.24, cache_read: 0.015 },
        limit: { context: 300000, output: 8192 },
        modalities: { input: ["text", "image", "video"], output: ["text"] },
        tool_call: true,
      },
      // No cache prices, so both directions fall to the bedrock multiplier.
      "deepseek.r1-v1:0": {
        id: "deepseek.r1-v1:0",
        name: "DeepSeek R1",
        cost: { input: 1.35, output: 5.4 },
        limit: { context: 128000, output: 32768 },
        modalities: { input: ["text"], output: ["text"] },
        tool_call: true,
      },
      // Deliberately absent: anthropic.claude-haiku-4-5 (so that row must fall
      // back to the vendor entry), plus the retired models the real registry
      // no longer carries at all.
    },
  },
  google: {
    id: "google",
    name: "Google",
    models: {
      "gemini-2.5-flash": {
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        cost: { input: 0.3, output: 2.5, cache_read: 0.03 },
        limit: { context: 1048576, output: 65536 },
        modalities: {
          input: ["text", "image", "audio", "video", "pdf"],
          output: ["text"],
        },
        tool_call: true,
      },
    },
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    models: {
      "deepseek/deepseek-chat-v3.1": {
        id: "deepseek/deepseek-chat-v3.1",
        name: "DeepSeek V3.1",
        cost: { input: 0.25, output: 0.95, cache_read: 0.13 },
        limit: { context: 163840, output: 32768 },
        modalities: { input: ["text"], output: ["text"] },
        tool_call: true,
      },
    },
  },
  mistral: {
    id: "mistral",
    name: "Mistral",
    models: {
      "mistral-large-latest": {
        id: "mistral-large-latest",
        name: "Mistral Large",
        cost: { input: 0.5, output: 1.5 },
        limit: { context: 262144, output: 262144 },
        modalities: { input: ["text", "image"], output: ["text"] },
        tool_call: true,
      },
    },
  },
  groq: {
    id: "groq",
    name: "Groq",
    models: {
      "llama-3.3-70b-versatile": {
        id: "llama-3.3-70b-versatile",
        name: "Llama 3.3 70B Versatile",
        cost: { input: 0.59, output: 0.79 },
        limit: { context: 131072, output: 32768 },
        modalities: { input: ["text"], output: ["text"] },
        tool_call: true,
      },
    },
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    models: {
      "deepseek-chat": {
        id: "deepseek-chat",
        name: "DeepSeek Chat",
        cost: { input: 0.14, output: 0.28, cache_read: 0.0028 },
        limit: { context: 1000000, output: 384000 },
        modalities: { input: ["text"], output: ["text"] },
        tool_call: true,
      },
    },
  },
  cerebras: {
    id: "cerebras",
    name: "Cerebras",
    models: {
      "gemma-4-31b": {
        id: "gemma-4-31b",
        name: "Gemma 4 31B",
        cost: { input: 0.99, output: 1.49 },
        limit: { context: 131072, output: 40960 },
        modalities: { input: ["text", "image"], output: ["text"] },
        tool_call: true,
      },
    },
  },
};

interface ExpectedCapabilities {
  contextLength: number | null;
  outputLength: number | null;
  inputModalities: ModelInputModality[] | null;
  outputModalities: ModelOutputModality[] | null;
  supportsToolCalling: boolean | null;
  pricePerMillionInput: string;
  pricePerMillionOutput: string;
  priceSource: PriceSource;
  pricePerMillionCacheRead: string | null;
  pricePerMillionCacheWrite: string | null;
  cachePriceSource: PriceSource | null;
  embeddingDimensions?: number | null;
}

interface MatrixRow {
  /** Reads as the test name, so it should say which path the row covers. */
  name: string;
  provider: SupportedProvider;
  modelId: string;
  underlyingModelName?: string;
  fetched?: FetchedModelCapabilities;
  /**
   * Route the row through the LLM proxy's discovery path instead of a sync.
   * A model the proxy names is written bare under the *endpoint's* provider and
   * is never revisited by a sync, so it resolves through a different path and
   * belongs in the same table rather than a private one.
   */
  discovered?: true;
  expected: ExpectedCapabilities;
}

const MATRIX: MatrixRow[] = [
  // --- OpenAI: same-provider registry lookup ------------------------------
  {
    name: "openai/gpt-4o — exact key; synced cache-read, derived cache-write",
    provider: "openai",
    modelId: "gpt-4o",
    expected: {
      contextLength: 128000,
      outputLength: 16384,
      inputModalities: ["text", "image", "pdf"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "2.50",
      pricePerMillionOutput: "10.00",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "1.25",
      pricePerMillionCacheWrite: "0",
      cachePriceSource: "models_dev",
    },
  },
  {
    name: "openai/gpt-4o-mini-2024-07-18 — dated id resolves to the dateless key",
    provider: "openai",
    modelId: "gpt-4o-mini-2024-07-18",
    expected: {
      contextLength: 128000,
      outputLength: 16384,
      inputModalities: ["text", "image", "pdf"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "0.15",
      pricePerMillionOutput: "0.60",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "0.075",
      pricePerMillionCacheWrite: "0",
      cachePriceSource: "models_dev",
    },
  },
  {
    name: "openai/gpt-4.1-nano-2025-04-14 — dated id; '-nano' must not win the $30 tier",
    provider: "openai",
    modelId: "gpt-4.1-nano-2025-04-14",
    expected: {
      contextLength: 1047576,
      outputLength: 32768,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "0.10",
      pricePerMillionOutput: "0.40",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "0.025",
      pricePerMillionCacheWrite: "0",
      cachePriceSource: "models_dev",
    },
  },
  {
    name: "openai/gpt-5.4-2026-03-05 — dated id resolves to the dateless key",
    provider: "openai",
    modelId: "gpt-5.4-2026-03-05",
    expected: {
      contextLength: 1050000,
      outputLength: 128000,
      inputModalities: ["text", "image", "pdf"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "2.50",
      pricePerMillionOutput: "15.00",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "0.25",
      pricePerMillionCacheWrite: "0",
      cachePriceSource: "models_dev",
    },
  },
  {
    name: "openai/gpt-5.4 — undated control for the row above",
    provider: "openai",
    modelId: "gpt-5.4",
    expected: {
      contextLength: 1050000,
      outputLength: 128000,
      inputModalities: ["text", "image", "pdf"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "2.50",
      pricePerMillionOutput: "15.00",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "0.25",
      pricePerMillionCacheWrite: "0",
      cachePriceSource: "models_dev",
    },
  },
  {
    name: "openai/gpt-3.5-turbo — a synced cache_read of 0 stays 0, not a derived price",
    provider: "openai",
    modelId: "gpt-3.5-turbo",
    expected: {
      contextLength: 16385,
      outputLength: 4096,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: false,
      pricePerMillionInput: "0.50",
      pricePerMillionOutput: "1.50",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "0",
      pricePerMillionCacheWrite: "0",
      cachePriceSource: "models_dev",
    },
  },
  {
    name: "openai/gpt-3.5-turbo-0125 — a bare 4-digit suffix is deliberately not stripped",
    provider: "openai",
    modelId: "gpt-3.5-turbo-0125",
    expected: {
      contextLength: null,
      outputLength: null,
      inputModalities: null,
      outputModalities: null,
      supportsToolCalling: null,
      pricePerMillionInput: "50.00",
      pricePerMillionOutput: "50.00",
      priceSource: "default",
      pricePerMillionCacheRead: "12.5",
      pricePerMillionCacheWrite: "0",
      cachePriceSource: "derived_multiplier",
    },
  },
  {
    name: "openai/text-embedding-3-small — embedding model, no cache_read in the registry",
    provider: "openai",
    modelId: "text-embedding-3-small",
    expected: {
      contextLength: 8191,
      outputLength: 1536,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: false,
      pricePerMillionInput: "0.02",
      pricePerMillionOutput: "0.00",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "0.005",
      pricePerMillionCacheWrite: "0",
      cachePriceSource: "derived_multiplier",
      embeddingDimensions: 1536,
    },
  },

  // --- OpenAI: models the registry omits, priced from OpenAI's own list ----
  {
    name: "openai/gpt-5.1-codex — absent from the registry, so the published map fills it",
    provider: "openai",
    modelId: "gpt-5.1-codex",
    expected: {
      contextLength: null,
      outputLength: null,
      inputModalities: null,
      outputModalities: null,
      supportsToolCalling: null,
      pricePerMillionInput: "1.25",
      pricePerMillionOutput: "10.00",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "0.125",
      // OpenAI bills nothing to write to the cache, so the derived write is 0.
      pricePerMillionCacheWrite: "0",
      cachePriceSource: "models_dev",
    },
  },
  {
    name: "openai/gpt-5.1-codex-mini — priced apart from the model its name contains",
    provider: "openai",
    modelId: "gpt-5.1-codex-mini",
    expected: {
      contextLength: null,
      outputLength: null,
      inputModalities: null,
      outputModalities: null,
      supportsToolCalling: null,
      // A fifth of `gpt-5.1-codex`: deriving one from the other by stripping
      // the suffix would bill this at five times its published rate.
      pricePerMillionInput: "0.25",
      pricePerMillionOutput: "2.00",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "0.025",
      pricePerMillionCacheWrite: "0",
      cachePriceSource: "models_dev",
    },
  },

  // --- Anthropic ----------------------------------------------------------
  {
    name: "anthropic/claude-opus-4-8 — both cache directions synced",
    provider: "anthropic",
    modelId: "claude-opus-4-8",
    expected: {
      contextLength: 1000000,
      outputLength: 128000,
      inputModalities: ["text", "image", "pdf"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "5.00",
      pricePerMillionOutput: "25.00",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "0.5",
      pricePerMillionCacheWrite: "6.25",
      cachePriceSource: "models_dev",
    },
  },
  {
    name: "anthropic/claude-haiku-4-5 — a registry price beats the '-haiku' $30 tier",
    provider: "anthropic",
    modelId: "claude-haiku-4-5",
    expected: {
      contextLength: 200000,
      outputLength: 64000,
      inputModalities: ["text", "image", "pdf"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "1.00",
      pricePerMillionOutput: "5.00",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "0.1",
      pricePerMillionCacheWrite: "1.25",
      cachePriceSource: "models_dev",
    },
  },
  {
    name: "anthropic/claude-sonnet-4-5 — 1M window direct from the vendor",
    provider: "anthropic",
    modelId: "claude-sonnet-4-5",
    expected: {
      contextLength: 1000000,
      outputLength: 64000,
      inputModalities: ["text", "image", "pdf"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "3.00",
      pricePerMillionOutput: "15.00",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "0.3",
      pricePerMillionCacheWrite: "3.75",
      cachePriceSource: "models_dev",
    },
  },

  // --- Proxy discovery: model recorded under the endpoint's provider -------
  {
    name: "discovered/bedrock:gpt-4o — a vendor model that reached a mismatched endpoint",
    provider: "bedrock",
    modelId: "gpt-4o",
    discovered: true,
    expected: {
      contextLength: 128000,
      outputLength: 16384,
      // Enrichment deliberately writes no modalities: validating them against
      // the column schema lives in the sync path.
      inputModalities: null,
      outputModalities: null,
      supportsToolCalling: true,
      pricePerMillionInput: "2.50",
      pricePerMillionOutput: "10.00",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "1.25",
      // The registry entry carries no cache-write price, so it derives from the
      // input price rather than being synced.
      pricePerMillionCacheWrite: "3.125",
      cachePriceSource: "models_dev",
    },
  },
  {
    name: "discovered/bedrock:us.amazon.nova-lite — still resolves through the provider-scoped path",
    provider: "bedrock",
    modelId: "us.amazon.nova-lite-v1:0",
    discovered: true,
    expected: {
      contextLength: 300000,
      outputLength: 8192,
      inputModalities: null,
      outputModalities: null,
      supportsToolCalling: true,
      pricePerMillionInput: "0.06",
      pricePerMillionOutput: "0.24",
      // The AWS snapshot lists this model at the same rate, so the stored price
      // matches it and the provenance reads as AWS.
      priceSource: "aws",
      pricePerMillionCacheRead: "0.015",
      pricePerMillionCacheWrite: "0.075",
      cachePriceSource: "models_dev",
    },
  },
  {
    name: "discovered/bedrock:unlisted — no first-party vendor lists it, so no price is asserted",
    provider: "bedrock",
    modelId: "us.anthropic.claude-notarealmodel-v1:0",
    discovered: true,
    expected: {
      contextLength: null,
      outputLength: null,
      inputModalities: null,
      outputModalities: null,
      supportsToolCalling: null,
      pricePerMillionInput: "50.00",
      pricePerMillionOutput: "50.00",
      priceSource: "default",
      pricePerMillionCacheRead: "5",
      pricePerMillionCacheWrite: "62.5",
      cachePriceSource: "derived_multiplier",
    },
  },
  {
    name: "discovered/bedrock:gpt-5.1-codex — no registry provider carries it, so the published map does",
    provider: "bedrock",
    modelId: "gpt-5.1-codex",
    discovered: true,
    expected: {
      contextLength: null,
      outputLength: null,
      inputModalities: null,
      outputModalities: null,
      supportsToolCalling: null,
      pricePerMillionInput: "1.25",
      pricePerMillionOutput: "10.00",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "0.125",
      pricePerMillionCacheWrite: "1.5625",
      cachePriceSource: "models_dev",
    },
  },

  // --- Bedrock: cross-provider resolution ---------------------------------
  {
    name: "bedrock/us.anthropic.claude-sonnet-4-5 — 200K from the bedrock entry, not the vendor's 1M",
    provider: "bedrock",
    modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    expected: {
      contextLength: 200000,
      outputLength: 64000,
      inputModalities: ["text", "image", "pdf"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "3.00",
      pricePerMillionOutput: "15.00",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "0.3",
      pricePerMillionCacheWrite: "3.75",
      cachePriceSource: "models_dev",
    },
  },
  {
    name: "bedrock/global.anthropic.claude-sonnet-4-5 — the registry prices every endpoint tier the same",
    provider: "bedrock",
    modelId: "global.anthropic.claude-sonnet-4-5-20250929-v1:0",
    expected: {
      contextLength: 200000,
      outputLength: 64000,
      inputModalities: ["text", "image", "pdf"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "3.00",
      pricePerMillionOutput: "15.00",
      priceSource: "aws",
      pricePerMillionCacheRead: "0.3",
      pricePerMillionCacheWrite: "3.75",
      cachePriceSource: "models_dev",
    },
  },
  {
    name: "bedrock/us.amazon.nova-lite — resolves via the amazon-bedrock entry (no vendor entry exists)",
    provider: "bedrock",
    modelId: "us.amazon.nova-lite-v1:0",
    expected: {
      contextLength: 300000,
      outputLength: 8192,
      inputModalities: ["text", "image", "video"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "0.06",
      pricePerMillionOutput: "0.24",
      priceSource: "aws",
      pricePerMillionCacheRead: "0.015",
      pricePerMillionCacheWrite: "0.075",
      cachePriceSource: "models_dev",
    },
  },
  {
    name: "bedrock/us.deepseek.r1 — no synced cache, so both directions use the bedrock multiplier",
    provider: "bedrock",
    modelId: "us.deepseek.r1-v1:0",
    expected: {
      contextLength: 128000,
      outputLength: 32768,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "1.35",
      pricePerMillionOutput: "5.40",
      priceSource: "aws",
      pricePerMillionCacheRead: "0.135",
      pricePerMillionCacheWrite: "1.6875",
      cachePriceSource: "derived_multiplier",
    },
  },
  {
    name: "bedrock/application-inference-profile — opaque id resolved via the ARN's foundation model",
    provider: "bedrock",
    modelId: "hq8s2mfl9k1r",
    underlyingModelName: "anthropic.claude-sonnet-4-5-20250929-v1:0",
    expected: {
      contextLength: 200000,
      outputLength: 64000,
      inputModalities: ["text", "image", "pdf"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "3.00",
      pricePerMillionOutput: "15.00",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "0.3",
      pricePerMillionCacheWrite: "3.75",
      cachePriceSource: "models_dev",
    },
  },
  {
    name: "bedrock/us.anthropic.claude-haiku-4-5 — falls back to the vendor entry when amazon-bedrock has none",
    provider: "bedrock",
    modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    expected: {
      contextLength: 200000,
      outputLength: 64000,
      inputModalities: ["text", "image", "pdf"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "1.00",
      pricePerMillionOutput: "5.00",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "0.1",
      pricePerMillionCacheWrite: "1.25",
      cachePriceSource: "models_dev",
    },
  },
  {
    name: "bedrock/us.anthropic.claude-3-sonnet — retired from the registry, priced by AWS",
    provider: "bedrock",
    modelId: "us.anthropic.claude-3-sonnet-20240229-v1:0",
    expected: {
      contextLength: null,
      outputLength: null,
      inputModalities: null,
      outputModalities: null,
      supportsToolCalling: null,
      pricePerMillionInput: "3.00",
      pricePerMillionOutput: "15.00",
      priceSource: "aws",
      pricePerMillionCacheRead: "0.3",
      pricePerMillionCacheWrite: "3.75",
      cachePriceSource: "derived_multiplier",
    },
  },
  {
    name: "bedrock/amazon.titan-embed-text-v1 — embedding, priced by AWS on input alone",
    provider: "bedrock",
    modelId: "amazon.titan-embed-text-v1",
    expected: {
      contextLength: null,
      outputLength: null,
      inputModalities: null,
      outputModalities: null,
      supportsToolCalling: null,
      pricePerMillionInput: "0.10",
      pricePerMillionOutput: "0.00",
      priceSource: "aws",
      pricePerMillionCacheRead: "0.01",
      pricePerMillionCacheWrite: "0.125",
      cachePriceSource: "derived_multiplier",
    },
  },
  {
    name: "bedrock/us.meta.llama3-2-90b — retired from the registry, priced by AWS",
    provider: "bedrock",
    modelId: "us.meta.llama3-2-90b-instruct-v1:0",
    expected: {
      contextLength: null,
      outputLength: null,
      inputModalities: null,
      outputModalities: null,
      supportsToolCalling: null,
      pricePerMillionInput: "0.72",
      pricePerMillionOutput: "0.72",
      priceSource: "aws",
      pricePerMillionCacheRead: "0.072",
      pricePerMillionCacheWrite: "0.9",
      cachePriceSource: "derived_multiplier",
    },
  },
  {
    name: 'bedrock/us.anthropic.claude-3-haiku — a real price replaces the "-haiku" $30 tier',
    provider: "bedrock",
    modelId: "us.anthropic.claude-3-haiku-20240307-v1:0",
    expected: {
      contextLength: null,
      outputLength: null,
      inputModalities: null,
      outputModalities: null,
      supportsToolCalling: null,
      pricePerMillionInput: "0.25",
      pricePerMillionOutput: "1.25",
      priceSource: "aws",
      pricePerMillionCacheRead: "0.025",
      pricePerMillionCacheWrite: "0.3125",
      cachePriceSource: "derived_multiplier",
    },
  },

  // --- Azure: deployment names carry no vendor identity -------------------
  {
    name: "azure/deployment with a known underlying model name",
    provider: "azure",
    modelId: "my-gpt4o-deploy",
    underlyingModelName: "gpt-4o",
    expected: {
      contextLength: 128000,
      outputLength: 16384,
      inputModalities: ["text", "image", "pdf"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "2.50",
      pricePerMillionOutput: "10.00",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "1.25",
      pricePerMillionCacheWrite: null,
      cachePriceSource: "models_dev",
    },
  },
  {
    name: "azure/deployment named after its model, with no underlying name reported",
    provider: "azure",
    modelId: "gpt-4o",
    expected: {
      contextLength: 128000,
      outputLength: 16384,
      inputModalities: ["text", "image", "pdf"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "2.50",
      pricePerMillionOutput: "10.00",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "1.25",
      pricePerMillionCacheWrite: null,
      cachePriceSource: "models_dev",
    },
  },
  {
    name: "azure/opaquely-named embedding deployment — emits no output modality, despite the vendor entry claiming text",
    provider: "azure",
    modelId: "prod-deploy-7f3a",
    underlyingModelName: "text-embedding-3-small",
    expected: {
      contextLength: 8191,
      outputLength: 1536,
      inputModalities: ["text"],
      outputModalities: [],
      supportsToolCalling: false,
      pricePerMillionInput: "0.02",
      pricePerMillionOutput: "0.00",
      priceSource: "models_dev",
      pricePerMillionCacheRead: null,
      pricePerMillionCacheWrite: null,
      cachePriceSource: null,
    },
  },
  {
    name: "azure/deployment that matches no known model",
    provider: "azure",
    modelId: "totally-custom-deployment",
    expected: {
      contextLength: null,
      outputLength: null,
      inputModalities: null,
      outputModalities: null,
      supportsToolCalling: null,
      pricePerMillionInput: "50.00",
      pricePerMillionOutput: "50.00",
      priceSource: "default",
      pricePerMillionCacheRead: null,
      pricePerMillionCacheWrite: null,
      cachePriceSource: null,
    },
  },

  // --- OpenRouter: the fetcher reports its own prices ---------------------
  {
    name: "openrouter/:free — a fetched price of zero must survive, not fall to the default tier",
    provider: "openrouter",
    modelId: "deepseek/deepseek-chat-v3.1:free",
    fetched: {
      contextLength: 163840,
      supportsToolCalling: true,
      promptPricePerToken: "0",
      completionPricePerToken: "0",
    },
    expected: {
      contextLength: 163840,
      outputLength: null,
      inputModalities: null,
      outputModalities: null,
      supportsToolCalling: true,
      pricePerMillionInput: "0.00",
      pricePerMillionOutput: "0.00",
      priceSource: "models_dev",
      pricePerMillionCacheRead: null,
      pricePerMillionCacheWrite: null,
      cachePriceSource: null,
    },
  },
  {
    name: "openrouter/fetched values outrank the registry field by field",
    provider: "openrouter",
    modelId: "deepseek/deepseek-chat-v3.1",
    fetched: {
      contextLength: 99000,
      supportsToolCalling: false,
      promptPricePerToken: "0.000001",
      completionPricePerToken: "0.000002",
    },
    expected: {
      contextLength: 99000,
      outputLength: 32768,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: false,
      pricePerMillionInput: "1.00",
      pricePerMillionOutput: "2.00",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "0.13",
      pricePerMillionCacheWrite: null,
      cachePriceSource: "models_dev",
    },
  },
  {
    name: "openrouter/no fetched capabilities — everything comes from the registry",
    provider: "openrouter",
    modelId: "deepseek/deepseek-chat-v3.1",
    expected: {
      contextLength: 163840,
      outputLength: 32768,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "0.25",
      pricePerMillionOutput: "0.95",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "0.13",
      pricePerMillionCacheWrite: null,
      cachePriceSource: "models_dev",
    },
  },

  // --- Ollama: local models, absent from models.dev entirely, and billed
  // no per-token rate on either transport (zero, not the generic estimate) ---
  {
    name: "ollama/a Modelfile num_ctx caps the window below the architectural one",
    provider: "ollama",
    modelId: "llama3.2",
    fetched: {
      contextLength: 262144,
      defaultParameters: { num_ctx: 8192 },
    },
    expected: {
      contextLength: 8192,
      outputLength: null,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: null,
      pricePerMillionInput: "0.00",
      pricePerMillionOutput: "0.00",
      priceSource: "default",
      pricePerMillionCacheRead: null,
      pricePerMillionCacheWrite: null,
      cachePriceSource: null,
    },
  },
  {
    name: "ollama/without a num_ctx the architectural window stands",
    provider: "ollama",
    modelId: "llama3.2",
    fetched: { contextLength: 262144 },
    expected: {
      contextLength: 262144,
      outputLength: null,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: null,
      pricePerMillionInput: "0.00",
      pricePerMillionOutput: "0.00",
      priceSource: "default",
      pricePerMillionCacheRead: null,
      pricePerMillionCacheWrite: null,
      cachePriceSource: null,
    },
  },
  {
    name: "ollama/an embedding model reports its dimension and no output modality",
    provider: "ollama",
    modelId: "nomic-embed-text",
    fetched: { embeddingDimensions: 768 },
    expected: {
      contextLength: null,
      outputLength: null,
      inputModalities: ["text"],
      outputModalities: [],
      supportsToolCalling: null,
      pricePerMillionInput: "0.00",
      pricePerMillionOutput: "0.00",
      priceSource: "default",
      pricePerMillionCacheRead: null,
      pricePerMillionCacheWrite: null,
      cachePriceSource: null,
      embeddingDimensions: 768,
    },
  },

  // --- Gemini -------------------------------------------------------------
  {
    name: "gemini/gemini-2.5-flash — multimodal input from the registry",
    provider: "gemini",
    modelId: "gemini-2.5-flash",
    expected: {
      contextLength: 1048576,
      outputLength: 65536,
      inputModalities: ["text", "image", "audio", "video", "pdf"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "0.30",
      pricePerMillionOutput: "2.50",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "0.03",
      pricePerMillionCacheWrite: "0",
      cachePriceSource: "models_dev",
    },
  },
  {
    name: "gemini/gemini-embedding-2-preview — normalized to multimodal input with no output",
    provider: "gemini",
    modelId: "gemini-embedding-2-preview",
    expected: {
      contextLength: null,
      outputLength: null,
      inputModalities: ["text", "image"],
      outputModalities: [],
      supportsToolCalling: false,
      pricePerMillionInput: "50.00",
      pricePerMillionOutput: "50.00",
      priceSource: "default",
      pricePerMillionCacheRead: "12.5",
      pricePerMillionCacheWrite: "0",
      cachePriceSource: "derived_multiplier",
      embeddingDimensions: 3072,
    },
  },

  // --- Provider breadth ---------------------------------------------------
  {
    name: "mistral/mistral-large-latest — provider has no cache pricing model",
    provider: "mistral",
    modelId: "mistral-large-latest",
    expected: {
      contextLength: 262144,
      outputLength: 262144,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "0.50",
      pricePerMillionOutput: "1.50",
      priceSource: "models_dev",
      pricePerMillionCacheRead: null,
      pricePerMillionCacheWrite: null,
      cachePriceSource: null,
    },
  },
  {
    name: "groq/llama-3.3-70b-versatile",
    provider: "groq",
    modelId: "llama-3.3-70b-versatile",
    expected: {
      contextLength: 131072,
      outputLength: 32768,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "0.59",
      pricePerMillionOutput: "0.79",
      priceSource: "models_dev",
      pricePerMillionCacheRead: null,
      pricePerMillionCacheWrite: null,
      cachePriceSource: null,
    },
  },
  {
    name: "deepseek/deepseek-chat — sub-cent cache price keeps its precision",
    provider: "deepseek",
    modelId: "deepseek-chat",
    expected: {
      contextLength: 1000000,
      outputLength: 384000,
      inputModalities: ["text"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "0.14",
      pricePerMillionOutput: "0.28",
      priceSource: "models_dev",
      pricePerMillionCacheRead: "0.0028",
      pricePerMillionCacheWrite: "0",
      cachePriceSource: "models_dev",
    },
  },
  {
    name: "cerebras/gemma-4-31b",
    provider: "cerebras",
    modelId: "gemma-4-31b",
    expected: {
      contextLength: 131072,
      outputLength: 40960,
      inputModalities: ["text", "image"],
      outputModalities: ["text"],
      supportsToolCalling: true,
      pricePerMillionInput: "0.99",
      pricePerMillionOutput: "1.49",
      priceSource: "models_dev",
      pricePerMillionCacheRead: null,
      pricePerMillionCacheWrite: null,
      cachePriceSource: null,
    },
  },

  // --- Negative control ---------------------------------------------------
  {
    name: "openai/gpt-4o-search-preview-2025-03-11 — stripping the date must not match a different model",
    provider: "openai",
    modelId: "gpt-4o-search-preview-2025-03-11",
    expected: {
      contextLength: null,
      outputLength: null,
      inputModalities: null,
      outputModalities: null,
      supportsToolCalling: null,
      pricePerMillionInput: "50.00",
      pricePerMillionOutput: "50.00",
      priceSource: "default",
      pricePerMillionCacheRead: "12.5",
      pricePerMillionCacheWrite: "0",
      cachePriceSource: "derived_multiplier",
    },
  },
];

/**
 * How many rows above resolve to no registry price and land on the $50/$30
 * estimate. Pinning the count makes adding another one a deliberate act:
 * the guard below fails until someone updates this number, which is the moment
 * to ask whether that model should really be unpriced.
 */
const EXPECTED_DEFAULT_PRICED_ROWS = 8;

/**
 * Reproduce what the LLM proxy does the first time it sees a model: write the
 * bare row under the endpoint's provider, then enrich it from the registry.
 */
async function discoverAndEnrich(row: MatrixRow) {
  const created = await ModelModel.ensureModelExists(row.modelId, row.provider);
  if (!created) {
    throw new Error(`expected ${row.provider}/${row.modelId} to be created`);
  }
  await enrichDiscoveredModel({ model: created, modelsDevData: MODELS_DEV });
  const model = await ModelModel.findByProviderAndModelId(
    row.provider,
    row.modelId,
  );
  if (!model) {
    throw new Error(`expected ${row.provider}/${row.modelId} to be readable`);
  }
  return model;
}

describe("model capability matrix", () => {
  for (const row of MATRIX) {
    test(row.name, async () => {
      const model = row.discovered
        ? await discoverAndEnrich(row)
        : (
            await ModelModel.bulkUpsert(
              buildModelsToUpsert({
                provider: row.provider,
                models: [
                  {
                    id: row.modelId,
                    capabilities: row.fetched,
                    underlyingModelName: row.underlyingModelName ?? null,
                  },
                ],
                modelsDevData: MODELS_DEV,
              }),
            )
          )[0];

      const capabilities = ModelModel.toCapabilities(model);

      expect({
        contextLength: capabilities.contextLength,
        outputLength: model.outputLength,
        inputModalities: capabilities.inputModalities,
        outputModalities: capabilities.outputModalities,
        supportsToolCalling: capabilities.supportsToolCalling,
        pricePerMillionInput: capabilities.pricePerMillionInput,
        pricePerMillionOutput: capabilities.pricePerMillionOutput,
        priceSource: capabilities.priceSource,
        pricePerMillionCacheRead: capabilities.pricePerMillionCacheRead,
        pricePerMillionCacheWrite: capabilities.pricePerMillionCacheWrite,
        cachePriceSource: capabilities.cachePriceSource,
        ...(row.expected.embeddingDimensions !== undefined
          ? { embeddingDimensions: model.embeddingDimensions }
          : {}),
      }).toEqual(row.expected);
    });
  }

  test("only the known-unpriced models fall through to the estimate", () => {
    const unpriced = MATRIX.filter((row) => {
      // Each row is judged by the path it actually takes. Running a discovered
      // row through the sync builder would report it unpriced for a resolution
      // it never performs, hiding the estimate this guard exists to surface.
      if (row.discovered) {
        return (
          resolveDiscoveredModelRegistryEntry({
            provider: row.provider,
            modelId: row.modelId,
            modelsDevData: MODELS_DEV,
          })?.prices?.promptPricePerToken == null &&
          lookupOpenAiPublishedPrices(row.modelId) == null
        );
      }
      const [built] = buildModelsToUpsert({
        provider: row.provider,
        models: [
          {
            id: row.modelId,
            capabilities: row.fetched,
            underlyingModelName: row.underlyingModelName ?? null,
          },
        ],
        modelsDevData: MODELS_DEV,
      });
      return built.promptPricePerToken === null;
    }).map((row) => row.name);

    expect(unpriced).toHaveLength(EXPECTED_DEFAULT_PRICED_ROWS);
  });
});
