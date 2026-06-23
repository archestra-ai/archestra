import { z } from "zod";

/**
 * Supported LLM providers
 */
export const SupportedProvidersSchema = z.enum([
  "openai",
  "gemini",
  "anthropic",
  "bedrock",
  "cohere",
  "cerebras",
  "mistral",
  "perplexity",
  "groq",
  "xai",
  "openrouter",
  "vllm",
  "ollama",
  "zhipuai",
  "deepseek",
  "minimax",
  "azure",
  "github-copilot",
]);

export const SupportedProvidersDiscriminatorSchema = z.enum([
  "openai:chatCompletions",
  "openai:responses",
  "openai:embeddings",
  "gemini:generateContent",
  "gemini:embeddings",
  "anthropic:messages",
  "bedrock:converse",
  "cohere:chat",
  "cerebras:chatCompletions",
  "mistral:chatCompletions",
  "perplexity:chatCompletions",
  "groq:chatCompletions",
  "xai:chatCompletions",
  "openrouter:chatCompletions",
  "vllm:chatCompletions",
  "ollama:chatCompletions",
  "zhipuai:chatCompletions",
  "deepseek:chatCompletions",
  "minimax:chatCompletions",
  "azure:chatCompletions",
  "azure:responses",
  "github-copilot:chatCompletions",
]);

export const SupportedProviders = Object.values(SupportedProvidersSchema.enum);
export type SupportedProvider = z.infer<typeof SupportedProvidersSchema>;

/**
 * Type guard to check if a value is a valid SupportedProvider
 */
export function isSupportedProvider(
  value: unknown,
): value is SupportedProvider {
  return SupportedProvidersSchema.safeParse(value).success;
}

export type SupportedProviderDiscriminator = z.infer<
  typeof SupportedProvidersDiscriminatorSchema
>;

export const providerDisplayNames: Record<SupportedProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  bedrock: "AWS Bedrock",
  gemini: "Gemini",
  cohere: "Cohere",
  cerebras: "Cerebras",
  mistral: "Mistral AI",
  perplexity: "Perplexity AI",
  groq: "Groq",
  xai: "xAI",
  openrouter: "OpenRouter",
  vllm: "vLLM",
  ollama: "Ollama",
  zhipuai: "Zhipu AI",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  azure: "Azure AI Foundry",
  "github-copilot": "GitHub Copilot",
};

/**
 * Providers where an API key can be omitted when creating a provider key.
 * Self-hosted providers are always optional. Azure is optional only when
 * Microsoft Entra ID authentication is enabled in the backend environment.
 */
const PROVIDERS_WITH_OPTIONAL_API_KEY = new Set<SupportedProvider>([
  "ollama",
  "vllm",
]);

/**
 * Providers that have no usable default endpoint, so an env-seeded key without an
 * explicit base URL is unusable: vLLM has no default at all (the OpenAI-compatible
 * SDK would silently fall back to api.openai.com), and Azure has no resource URL.
 * Bedrock is intentionally excluded — at runtime it infers a region (us-east-1
 * fallback) so chat works key-only/IAM even without a base URL (only its model-list
 * sync needs one). Gemini is excluded — its SDK supplies its own default.
 */
export const PROVIDERS_REQUIRING_BASE_URL = new Set<SupportedProvider>([
  "azure",
  "vllm",
]);

/**
 * Providers whose credential is an individual user's token rather than a shared
 * service key (GitHub Copilot: a per-user GitHub OAuth token tied to that
 * account's Copilot seat). Sharing one token across users is a ToS gray area
 * and breaks per-user attribution, so for these providers:
 * - keys are personal-scope only (no team/org scope, no virtual-key sharing);
 * - request-time resolution uses ONLY the acting user's personal key — never an
 *   agent's attached key, a conversation key, a team/org key, or the shared env
 *   fallback;
 * - a missing personal key surfaces a "link your account" prompt, not a fallback.
 */
export const PROVIDERS_REQUIRING_PER_USER_CREDENTIAL =
  new Set<SupportedProvider>(["github-copilot"]);

export function providerRequiresPerUserCredential(
  provider: SupportedProvider,
): boolean {
  return PROVIDERS_REQUIRING_PER_USER_CREDENTIAL.has(provider);
}

export function isProviderApiKeyOptional(params: {
  provider: SupportedProvider;
  azureEntraIdEnabled?: boolean;
}): boolean {
  return (
    PROVIDERS_WITH_OPTIONAL_API_KEY.has(params.provider) ||
    (params.provider === "azure" && params.azureEntraIdEnabled === true)
  );
}

export function getProvidersWithOptionalApiKey(params?: {
  azureEntraIdEnabled?: boolean;
}): SupportedProvider[] {
  const providers = [...PROVIDERS_WITH_OPTIONAL_API_KEY];
  if (params?.azureEntraIdEnabled === true) {
    providers.push("azure");
  }
  return providers;
}

/**
 * Perplexity model definitions — single source of truth.
 * Perplexity has no /models endpoint, so models are maintained here.
 * @see https://ai-sdk.dev/providers/ai-sdk-providers/perplexity#model-capabilities
 */
export const PERPLEXITY_MODELS = [
  { id: "sonar-pro", displayName: "Sonar Pro" },
  { id: "sonar", displayName: "Sonar" },
  { id: "sonar-reasoning-pro", displayName: "Sonar Reasoning Pro" },
  { id: "sonar-reasoning", displayName: "Sonar Reasoning" },
  { id: "sonar-deep-research", displayName: "Sonar Deep Research" },
] as const;

/**
 * MiniMax model definitions — single source of truth.
 * MiniMax does not provide a /v1/models endpoint, so models are maintained here.
 * @see https://platform.minimax.io/docs/guides/models-intro
 */
export const MINIMAX_MODELS = [
  { id: "MiniMax-M3", displayName: "MiniMax-M3" },
  { id: "MiniMax-M3-highspeed", displayName: "MiniMax-M3-highspeed" },
  { id: "MiniMax-M2.7", displayName: "MiniMax-M2.7" },
  { id: "MiniMax-M2.7-highspeed", displayName: "MiniMax-M2.7-highspeed" },
  { id: "MiniMax-M2.5", displayName: "MiniMax-M2.5" },
  { id: "MiniMax-M2.5-highspeed", displayName: "MiniMax-M2.5-highspeed" },
] as const;

/**
 * Default provider base URLs.
 * Used as placeholder hints in the UI and as fallback values when no per-key base URL is configured.
 */
export const DEFAULT_PROVIDER_BASE_URLS: Record<SupportedProvider, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
  bedrock: "",
  cohere: "https://api.cohere.ai",
  cerebras: "https://api.cerebras.ai/v1",
  mistral: "https://api.mistral.ai/v1",
  perplexity: "https://api.perplexity.ai",
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  vllm: "",
  ollama: "http://localhost:11434/v1",
  zhipuai: "https://api.z.ai/api/paas/v4",
  deepseek: "https://api.deepseek.com",
  minimax: "https://api.minimax.io/v1",
  azure: "https://<resource>.openai.azure.com/openai",
  "github-copilot": "https://api.githubcopilot.com",
};

/**
 * OpenRouter's built-in "Auto Router" — routes each request to a model OpenRouter
 * picks dynamically, billed at that model's rate. Not free.
 */
export const OPENROUTER_AUTO_MODEL_ID = "openrouter/auto";

/**
 * OpenRouter's built-in "Free Models Router" — routes each request to a free
 * model OpenRouter picks, filtering for the features the request needs. Always
 * zero-cost; used as the auto-default for fresh OpenRouter organizations.
 */
export const OPENROUTER_FREE_MODEL_ID = "openrouter/free";

/**
 * Prefix of OpenRouter "latest" alias ids (e.g. `~anthropic/claude-sonnet-latest`)
 * that always redirect to the newest model in a family.
 */
export const OPENROUTER_LATEST_ALIAS_PREFIX = "~";

/**
 * Pattern-based model markers per provider.
 * Patterns are substrings that model IDs must contain (case-insensitive).
 * Used to identify "best" (highest quality) models.
 *
 * Patterns are checked in array order (first match wins), so list each
 * provider's ids most- to least-preferred (more specific before general). The
 * first listed id present in the account is the one marked best.
 */
export const MODEL_MARKER_PATTERNS: Record<SupportedProvider, string[]> = {
  anthropic: ["opus-4-8", "opus-4-7", "opus", "sonnet"],
  openai: [
    "gpt-5.5-pro",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.3",
    "gpt-5",
    "gpt-4.1",
    "gpt-4o",
  ],
  gemini: ["gemini-3.1-pro-preview", "gemini-2.5-pro", "flash"],
  cerebras: ["zai-glm-4.7"],
  cohere: ["command-a-plus", "command-a", "command-r-plus", "command-r"],
  mistral: [
    "mistral-medium-2604",
    "mistral-large",
    "mistral-medium",
    "mistral-small",
  ],
  perplexity: [
    "sonar-deep-research",
    "sonar-reasoning-pro",
    "sonar-pro",
    "sonar",
  ],
  groq: ["openai/gpt-oss-120b", "gpt-oss", "llama-4", "llama-3.3"],
  xai: ["grok-4.3", "grok-4", "grok-3"],
  openrouter: [
    "anthropic/claude-opus-4.8",
    "anthropic/claude-opus-4.7",
    "openai/gpt-5.5-pro",
    "openai/gpt-5.5",
    "google/gemini-3.1-pro-preview",
    "x-ai/grok-4.3",
    "deepseek/deepseek-v4-pro",
  ],
  ollama: ["gpt-oss:120b", "llama4:maverick", "llama4:scout", "qwen3:235b"],
  vllm: ["gpt-oss-120b", "llama-4-maverick", "llama-4-scout", "qwen3-235b"],
  zhipuai: ["glm-5.1", "glm-5", "glm-4.7", "glm-4"],
  deepseek: ["deepseek-v4-pro", "deepseek-v4", "deepseek-v3", "deepseek-chat"],
  minimax: ["minimax-m3", "minimax-m2.7"],
  azure: [
    "gpt-5.5-pro",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.3",
    "gpt-5",
    "gpt-4.1",
    "gpt-4o",
  ],
  bedrock: [
    "anthropic.claude-opus-4-8",
    "anthropic.claude-opus-4-7",
    "claude-opus",
    "claude-sonnet",
    "amazon.nova-pro",
  ],
  "github-copilot": [
    "claude-opus",
    "claude-sonnet",
    "gpt-5",
    "gpt-4.1",
    "gpt-4o",
  ],
};

/**
 * Default model for each provider when no synced "best" model is available.
 * Using Record<SupportedProvider, string> ensures a compile-time error when a new provider is added.
 */
export const DEFAULT_MODELS: Record<SupportedProvider, string> = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-5.5",
  openrouter: "openrouter/auto",
  gemini: "gemini-3.5-flash",
  cohere: "command-a-plus-05-2026",
  groq: "openai/gpt-oss-120b",
  xai: "grok-4.3",
  ollama: "llama3.2",
  vllm: "default",
  cerebras: "zai-glm-4.7",
  mistral: "mistral-medium-2604",
  perplexity: "sonar-pro",
  zhipuai: "glm-5.1",
  deepseek: "deepseek-v4-pro",
  bedrock: "anthropic.claude-opus-4-8",
  minimax: "MiniMax-M3",
  azure: "gpt-5.5",
  "github-copilot": "gpt-4o",
};

/**
 * Cache token price as a multiple of the model's per-token INPUT price.
 * `read` = cache-read (cheap reuse); `write` = cache-creation (5-minute TTL)
 * surcharge; `write1h` = 1-hour TTL cache-write surcharge.
 *
 * Used as the fallback when a model has no explicit (synced or admin-set) cache
 * price: Anthropic/Bedrock bill a separate write surcharge (1.25x at 5m, 2x at
 * 1h), while OpenAI/Gemini/DeepSeek auto-cache with only a read discount and no
 * write surcharge. Providers absent from this map have no cache pricing model,
 * so cache cost/savings are not derived for them.
 */
export const CACHE_PRICE_MULTIPLIERS: Partial<
  Record<SupportedProvider, { read: number; write: number; write1h?: number }>
> = {
  anthropic: { read: 0.1, write: 1.25, write1h: 2 },
  bedrock: { read: 0.1, write: 1.25, write1h: 2 },
  openai: { read: 0.25, write: 0 },
  gemini: { read: 0.25, write: 0 },
  deepseek: { read: 0.1, write: 0 },
};

/**
 * True for OpenAI "pro" reasoning models, which OpenAI serves only through the
 * Responses API (`/v1/responses`). Calling them on `/v1/chat/completions`
 * returns `api_not_found_error` ("not a chat model"), so the chat client must
 * route these models to the Responses transport instead. "pro" is matched as a
 * hyphen/slash-delimited token, so dated snapshots (`gpt-5.5-pro-2026-01-01`)
 * are covered.
 */
export function requiresOpenAiResponsesApi(modelId: string): boolean {
  return /(?:^|[-/])pro(?:[-/]|$)/i.test(modelId);
}

/**
 * Maps models.dev provider IDs to Archestra provider names.
 * This is the single source of truth for all synchronization logic.
 *
 * Providers mapped to `null` are explicitly skipped during models.dev sync.
 * This includes providers that use custom authentication flows (e.g., Bedrock
 * uses SigV4, Azure uses Azure-specific auth) and are therefore managed
 * through their own dedicated sync pathways.
 */
export const MODELS_DEV_PROVIDER_MAP: Record<string, SupportedProvider | null> =
  {
    openai: "openai",
    openrouter: "openrouter",
    anthropic: "anthropic",
    google: "gemini",
    "google-vertex": "gemini",
    cohere: "cohere",
    cerebras: "cerebras",
    mistral: "mistral",
    minimax: "minimax",
    // These providers use OpenAI-compatible API in Archestra
    llama: "openai",
    deepseek: "deepseek",
    groq: "groq",
    "fireworks-ai": "openai",
    togetherai: "openai",
    xai: "xai",
    // Explicitly unsupported providers (return null to skip during models.dev sync)
    // Bedrock and Azure have dedicated auth flows and are not synced via models.dev
    "amazon-bedrock": null,
    azure: null,
    // GitHub Copilot model availability depends on the user's subscription tier,
    // so models are synced from Copilot's own /models endpoint, not models.dev
    "github-copilot": null,
    perplexity: null,
    nvidia: null,
  };
