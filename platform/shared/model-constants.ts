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
  "ollama-native",
  "zhipuai",
  "deepseek",
  "minimax",
  "kimi",
  "azure",
  "github-copilot",
  "microsoft-365-copilot",
  "archestra",
]);

export const SupportedProvidersDiscriminatorSchema = z.enum([
  "openai:chatCompletions",
  "openai:responses",
  "openai:embeddings",
  "gemini:generateContent",
  "gemini:embeddings",
  "anthropic:messages",
  "bedrock:converse",
  // Bedrock InvokeModel with an Anthropic model: the wire format is the
  // Anthropic Messages API (what the Anthropic SDK's Bedrock client and
  // Claude Code send), transported over Bedrock.
  "bedrock:invoke",
  "bedrock:embeddings",
  "cohere:chat",
  "cerebras:chatCompletions",
  "mistral:chatCompletions",
  "perplexity:chatCompletions",
  // Perplexity's Agent API, the provider's second transport: a Responses-shaped
  // surface serving the vendor-prefixed models and the only Perplexity endpoint
  // that accepts tools. See PERPLEXITY_AGENT_MODELS.
  "perplexity:responses",
  "groq:chatCompletions",
  "xai:chatCompletions",
  "openrouter:chatCompletions",
  "vllm:chatCompletions",
  "ollama:chatCompletions",
  "ollama-native:chat",
  "zhipuai:chatCompletions",
  "deepseek:chatCompletions",
  "minimax:chatCompletions",
  "kimi:chatCompletions",
  "azure:chatCompletions",
  "azure:responses",
  "github-copilot:chatCompletions",
  "microsoft-365-copilot:chatCompletions",
  "archestra:chatCompletions",
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
  ollama: "Ollama (OpenAI-compatible)",
  "ollama-native": "Ollama (Native)",
  zhipuai: "Zhipu AI",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  kimi: "Moonshot (Kimi)",
  azure: "Azure AI Foundry",
  "github-copilot": "GitHub Copilot",
  "microsoft-365-copilot": "Microsoft 365 Copilot",
  // white-label-ok: names the `archestra` upstream LLM provider a deployment connects to, not this deployment's own brand
  archestra: "Archestra",
};

/**
 * Providers where an API key can be omitted when creating a provider key.
 * Self-hosted providers are always optional. Azure is optional only when
 * Microsoft Entra ID authentication is enabled in the backend environment.
 */
const PROVIDERS_WITH_OPTIONAL_API_KEY = new Set<SupportedProvider>([
  "ollama",
  "ollama-native",
  "vllm",
]);

/**
 * Providers that charge no per-token rate, so their real price is zero rather
 * than unknown: the operator runs the server (vLLM, self-hosted Ollama), or the
 * vendor bills a flat subscription metered on compute time (Ollama's cloud).
 *
 * Listed explicitly rather than derived from the self-hosted-provider set it
 * currently matches, so that adding a keyless provider that does bill per token
 * cannot silently make its traffic free.
 */
export const PROVIDERS_BILLING_NO_TOKEN_RATE = new Set<SupportedProvider>([
  "ollama",
  "ollama-native",
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
  // Archestra-as-provider points at another Archestra instance's OpenAI-compatible
  // proxy endpoint (e.g. https://other/v1/proxy/openai/<agentId>); there is no
  // default, so a key without a base URL would silently route to api.openai.com.
  "archestra",
]);

/**
 * Providers whose credential is an individual user's token rather than a shared
 * service key (GitHub Copilot: a per-user GitHub OAuth token tied to that
 * account's Copilot seat; Microsoft 365 Copilot: a per-user Entra ID refresh token
 * tied to that account's Microsoft 365 Copilot license — the Graph Chat API
 * only supports delegated auth). Sharing one token across users is a ToS gray
 * area and breaks per-user attribution, so for these providers:
 * - keys are personal-scope only (no team/org scope, no virtual-key sharing);
 * - request-time resolution uses ONLY the acting user's personal key — never an
 *   agent's attached key, a conversation key, a team/org key, or the shared env
 *   fallback;
 * - a missing personal key surfaces a "link your account" prompt, not a fallback.
 */
export const PROVIDERS_REQUIRING_PER_USER_CREDENTIAL =
  new Set<SupportedProvider>(["github-copilot", "microsoft-365-copilot"]);

export function providerRequiresPerUserCredential(
  provider: SupportedProvider,
): boolean {
  return PROVIDERS_REQUIRING_PER_USER_CREDENTIAL.has(provider);
}

/**
 * Display name of the OpenAI "ChatGPT Subscription" (Codex) auth mode — the
 * credential-level per-user case on the `openai` provider, governed by the same
 * rules as PROVIDERS_REQUIRING_PER_USER_CREDENTIAL.
 */
export const CHATGPT_SUBSCRIPTION_LABEL = "ChatGPT Subscription";

export function isProviderApiKeyOptional(params: {
  provider: SupportedProvider;
  azureEntraIdEnabled?: boolean;
  anthropicWifEnabled?: boolean;
}): boolean {
  return (
    PROVIDERS_WITH_OPTIONAL_API_KEY.has(params.provider) ||
    (params.provider === "azure" && params.azureEntraIdEnabled === true) ||
    (params.provider === "anthropic" && params.anthropicWifEnabled === true)
  );
}

/**
 * Self-hosted providers whose endpoint typically points at a localhost / in-cluster
 * URL — the only ones the Docker-localhost connection hint applies to. This is the
 * *unconditional* optional-key set (Ollama, vLLM): cloud keyless providers (Azure
 * Entra ID, Anthropic WIF) are optional only via runtime flags, so they are excluded
 * automatically without a per-provider denylist.
 */
export function isSelfHostedProvider(provider: SupportedProvider): boolean {
  return PROVIDERS_WITH_OPTIONAL_API_KEY.has(provider);
}

/**
 * Total parameter count at or below which a model is surfaced as "small". 8B is
 * where the open-weight families that ship a tool-calling chat template start
 * (Llama 3.1 8B, Qwen3 8B), so it is the boundary below which a model is likely
 * to have been trained for chat rather than for tool use.
 *
 * A statement about SIZE, not quality, and the copy must stay that way:
 * parameter count is a poor predictor of agentic skill — Llama 3.3 70B scores
 * as low as a 12B model on published agentic benchmarks, so a threshold on size
 * can only ever say "small", never "weak".
 *
 * The bound is inclusive, but it sits just under the counts real 8B builds
 * report — Llama 3 8B reports 8_030_261_248 — so the nominal-8B tier falls
 * outside it and only genuinely smaller models are marked. That ~30M gap is
 * deliberate, not an off-by-one: closing it flips every 8B model to badged.
 *
 * Keep this at or below ~20B. Above that it starts catching mixture-of-experts
 * models (gpt-oss:20b, qwen3:30b-a3b), whose total parameter count describes
 * neither their compute per token nor their capability — at which point MoE
 * handling becomes load-bearing and this constant is no longer sufficient.
 */
export const SMALL_MODEL_MAX_PARAMETERS = 8_000_000_000;

/**
 * True when a model's reported size is small enough to warn about. Requires a
 * known count: null means the serving backend reported no size, and no claim is
 * made. Only Ollama reports one today, so this is null everywhere else.
 */
export function isSmallModel(parameterCount: number | null): boolean {
  return (
    parameterCount !== null && parameterCount <= SMALL_MODEL_MAX_PARAMETERS
  );
}

/**
 * Providers reachable through the OpenAI-compatible Model Router — either
 * because they already speak the OpenAI wire, or because the router translates
 * for them. Single source of truth: the router builds its own lookup from this
 * list, and the connection UI hides the router option for anything absent, so a
 * provider cannot appear to support the router while 404ing on it.
 *
 * `ollama-native` is deliberately absent: it speaks Ollama's `/api/chat` wire,
 * which the router has no translation for.
 */
export const MODEL_ROUTER_SUPPORTED_PROVIDERS = [
  // OpenAI-wire
  "openai",
  "azure",
  "cerebras",
  "deepseek",
  "groq",
  "minimax",
  "mistral",
  "ollama",
  "openrouter",
  "perplexity",
  "vllm",
  "xai",
  "zhipuai",
  // Translated by the router
  "anthropic",
  "bedrock",
  "cohere",
  "gemini",
] as const satisfies ReadonlyArray<SupportedProvider>;

export function isModelRouterSupportedProvider(
  provider: SupportedProvider,
): boolean {
  return (MODEL_ROUTER_SUPPORTED_PROVIDERS as readonly string[]).includes(
    provider,
  );
}

export function getProvidersWithOptionalApiKey(params?: {
  azureEntraIdEnabled?: boolean;
  anthropicWifEnabled?: boolean;
}): SupportedProvider[] {
  const providers = [...PROVIDERS_WITH_OPTIONAL_API_KEY];
  if (params?.azureEntraIdEnabled === true) {
    providers.push("azure");
  }
  if (params?.anthropicWifEnabled === true) {
    providers.push("anthropic");
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
  { id: "sonar-deep-research", displayName: "Sonar Deep Research" },
] as const;

/**
 * Perplexity models whose chain of thought is retrievable over the
 * chat-completions API.
 *
 * Perplexity only emits reasoning when the request opts into the `concise`
 * stream mode; the default `full` mode suppresses it entirely. The proxy sends
 * that opt-in for these models only, so the plain Sonar models keep the
 * default wire format.
 *
 * sonar-deep-research is deliberately absent: under `concise` it streams an
 * empty reasoning stage (a bare `chat.reasoning.done`, no steps) — its
 * research trace is not exposed on this API in any mode — so opting it in
 * yields no reasoning while changing its wire format for nothing.
 */
export const PERPLEXITY_REASONING_MODELS = ["sonar-reasoning-pro"] as const;

export function isPerplexityReasoningModel(model: string): boolean {
  return (PERPLEXITY_REASONING_MODELS as readonly string[]).includes(model);
}

/**
 * Perplexity Agent API model definitions — single source of truth.
 *
 * The `perplexity` provider's second surface, taking the same `pplx-` keys as
 * the `sonar*` chat-completions models above: it speaks a Responses-shaped
 * `input`/`output` wire format at `/v1/responses` and is the only Perplexity
 * endpoint that accepts `tools`. Its catalog is vendor-prefixed
 * (`perplexity/…`, `anthropic/…`, …) while the chat-completions catalog is the
 * bare `sonar*` family, and that slash is what routes a model to this
 * transport — see requiresPerplexityAgentApi. Like Sonar, it publishes no
 * usable /models endpoint, so the catalog is maintained here.
 *
 * Presets (`fast`, `low`, `medium`, `high`, `xhigh`) are deliberately absent.
 * They are a separate request field rather than a model id — each one bundles a
 * model with built-in web-search and fetch steps that bill per invocation — so
 * surfacing them as pseudo-models would misreport both the model in use and the
 * cost. They belong with built-in tool support, which this transport does not
 * carry.
 *
 * The list is the subset of the documented catalog that the live endpoint
 * actually serves (verified 2026-07-30): the documented `perplexity/sonar` and
 * every `openai/*` id (gpt-5.6-sol/-terra/-luna, gpt-5.4-mini) answer a bare
 * `invalid request` however they are asked — with or without tools or
 * reasoning options — so cataloguing them would only mint models that error
 * on every turn.
 *
 * @see https://docs.perplexity.ai/docs/agent-api/models
 */
export const PERPLEXITY_AGENT_MODELS = [
  { id: "perplexity/glm-5.2", displayName: "GLM 5.2" },
  { id: "perplexity/kimi-k3", displayName: "Kimi K3" },
  { id: "perplexity/kimi-k2.7-code", displayName: "Kimi K2.7 Code" },
  { id: "anthropic/claude-opus-5", displayName: "Claude Opus 5" },
  { id: "anthropic/claude-sonnet-5", displayName: "Claude Sonnet 5" },
  { id: "anthropic/claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
  { id: "google/gemini-3.1-pro-preview", displayName: "Gemini 3.1 Pro" },
  { id: "google/gemini-3.6-flash", displayName: "Gemini 3.6 Flash" },
  { id: "xai/grok-4.5", displayName: "Grok 4.5" },
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
 * The single pseudo-model exposed by the Microsoft 365 Copilot provider. The Graph
 * Chat API has no model selection — requests always run against the user's
 * Microsoft 365 Copilot — so the provider serves exactly this static model.
 */
export const MICROSOFT_365_COPILOT_MODELS = [
  { id: "microsoft-365-copilot", displayName: "Microsoft 365 Copilot" },
] as const;

/**
 * AWS regions that serve the Bedrock runtime, for the key form's region picker.
 * AWS adds regions faster than this list can track, so it is a convenience
 * shortlist rather than an authoritative set — a region missing here is still
 * reachable by typing its runtime endpoint into the form's custom-endpoint
 * field, which is what `bedrockRegionFromBaseUrl` reads back.
 */
export const BEDROCK_REGIONS = [
  { id: "us-east-1", label: "US East (N. Virginia)" },
  { id: "us-east-2", label: "US East (Ohio)" },
  { id: "us-west-2", label: "US West (Oregon)" },
  { id: "ca-central-1", label: "Canada (Central)" },
  { id: "sa-east-1", label: "South America (São Paulo)" },
  { id: "eu-west-1", label: "Europe (Ireland)" },
  { id: "eu-west-2", label: "Europe (London)" },
  { id: "eu-west-3", label: "Europe (Paris)" },
  { id: "eu-central-1", label: "Europe (Frankfurt)" },
  { id: "eu-north-1", label: "Europe (Stockholm)" },
  { id: "eu-south-1", label: "Europe (Milan)" },
  { id: "ap-south-1", label: "Asia Pacific (Mumbai)" },
  { id: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
  { id: "ap-northeast-2", label: "Asia Pacific (Seoul)" },
  { id: "ap-northeast-3", label: "Asia Pacific (Osaka)" },
  { id: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
  { id: "ap-southeast-2", label: "Asia Pacific (Sydney)" },
] as const;

/**
 * The region Bedrock falls back to when none can be determined. Mirrors the
 * backend's `getBedrockRegion` default so the form shows the region a key would
 * actually run against rather than an empty control.
 */
export const DEFAULT_BEDROCK_REGION = "us-east-1";

/** The Bedrock runtime (data-plane) endpoint for a region. */
export function bedrockRuntimeBaseUrl(region: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}

/**
 * Recover the AWS region from a Bedrock runtime endpoint. This is the single
 * definition of that parse — the backend resolves a key's region with it at
 * request time, and the key form uses it to show the region back when editing.
 *
 * Deliberately anchored on the `bedrock-runtime.` host label, so it also reads
 * VPC/PrivateLink endpoints that embed it. Returns null when no region can be
 * read, which is what makes an unparseable custom endpoint visible in the UI
 * instead of silently resolving to the default region.
 */
export function bedrockRegionFromBaseUrl(
  baseUrl: string | null | undefined,
): string | null {
  return baseUrl?.match(/bedrock-runtime\.([a-z0-9-]+)\./)?.[1] ?? null;
}

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
  // Sonar's chat-completions paths are rooted at the bare host; the Agent API
  // transport derives its `/v1`-suffixed base from this same value — see
  // perplexityAgentApiBaseUrl.
  perplexity: "https://api.perplexity.ai",
  groq: "https://api.groq.com/openai/v1",
  xai: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  vllm: "",
  ollama: "http://localhost:11434/v1",
  "ollama-native": "http://localhost:11434",
  zhipuai: "https://api.z.ai/api/paas/v4",
  deepseek: "https://api.deepseek.com",
  minimax: "https://api.minimax.io/v1",
  kimi: "https://api.moonshot.ai/v1",
  azure: "https://<resource>.openai.azure.com/openai",
  "github-copilot": "https://api.githubcopilot.com",
  "microsoft-365-copilot": "https://graph.microsoft.com/beta",
  // No default: the upstream is another Archestra instance's proxy endpoint,
  // supplied per key (e.g. https://your-archestra/v1/proxy/openai/<agentId>).
  archestra: "",
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
    // Sol is the 5.6 flagship tier; Terra the balanced one. Luna (nano tier)
    // is deliberately absent so it is never marked best over a 5.5 model.
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.5-pro",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.3",
    "gpt-5",
    "gpt-4.1",
    "gpt-4o",
  ],
  gemini: [
    "gemini-3.5-pro",
    "gemini-3.6-flash",
    "gemini-3.1-pro-preview",
    "gemini-3-pro",
    "gemini-3.5-flash",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
  ],
  cerebras: ["zai-glm-4.7"],
  cohere: ["command-a-plus", "command-a", "command-r-plus", "command-r"],
  mistral: [
    "mistral-medium-2604",
    "mistral-large",
    "mistral-medium",
    "mistral-small",
  ],
  // The bare `sonar*` chat-completions family leads so the provider's default
  // stays a Sonar model; the vendor-prefixed Agent API entries trail it,
  // mirroring the cross-vendor shape of `archestra` below.
  perplexity: [
    "sonar-deep-research",
    "sonar-reasoning-pro",
    "sonar-pro",
    "sonar",
    "anthropic/claude-opus-5",
    "anthropic/claude-sonnet-5",
    "perplexity/glm-5.2",
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
  "ollama-native": [
    "gpt-oss:120b",
    "llama4:maverick",
    "llama4:scout",
    "qwen3:235b",
  ],
  vllm: ["gpt-oss-120b", "llama-4-maverick", "llama-4-scout", "qwen3-235b"],
  zhipuai: ["glm-5.1", "glm-5", "glm-4.7", "glm-4"],
  deepseek: ["deepseek-v4-pro", "deepseek-v4", "deepseek-v3", "deepseek-chat"],
  minimax: ["minimax-m3", "minimax-m2.7"],
  kimi: [
    "kimi-k2-thinking",
    "kimi-k2-turbo",
    "kimi-k2",
    "kimi-latest",
    "moonshot-v1-128k",
    "kimi",
  ],
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
  "microsoft-365-copilot": [MICROSOFT_365_COPILOT_MODELS[0].id],
  // The upstream Archestra can front any provider, so match common flagship
  // families across vendors (most- to least-preferred).
  archestra: ["opus", "sonnet", "gpt-5", "gemini-3", "grok-4"],
};

/**
 * Default model for each provider when no synced "best" model is available.
 * Using Record<SupportedProvider, string> ensures a compile-time error when a new provider is added.
 */
export const DEFAULT_MODELS: Record<SupportedProvider, string> = {
  anthropic: "claude-opus-4-8",
  openai: "gpt-5.5",
  openrouter: "openrouter/auto",
  gemini: "gemini-3.6-flash",
  cohere: "command-a-plus-05-2026",
  groq: "openai/gpt-oss-120b",
  xai: "grok-4.3",
  ollama: "llama3.2",
  "ollama-native": "llama3.2",
  vllm: "default",
  cerebras: "zai-glm-4.7",
  mistral: "mistral-medium-2604",
  perplexity: "sonar-pro",
  zhipuai: "glm-5.1",
  deepseek: "deepseek-v4-pro",
  bedrock: "anthropic.claude-opus-4-8",
  minimax: "MiniMax-M3",
  kimi: "kimi-k2-0711-preview",
  azure: "gpt-5.5",
  "github-copilot": "gpt-4o",
  "microsoft-365-copilot": MICROSOFT_365_COPILOT_MODELS[0].id,
  // Fallback only; users pick from the upstream's fetched model list.
  archestra: "gpt-4o",
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
 * A bracketed context-variant marker some clients append to a Claude model id,
 * such as the `[1m]` in `claude-opus-4-8[1m]`.
 */
const CLAUDE_CONTEXT_VARIANT_SUFFIX = /\[\d+[km]\]$/i;

/**
 * Drop a client-side context-variant marker from a Claude model id.
 *
 * The marker is a client convention, not part of any Anthropic model id: every
 * Claude model with a 1M-token window has it by default, needs no beta header,
 * and bills at standard pricing, so the marked id names the same model at the
 * same price. Carried through to storage it becomes a second model record that
 * no catalog lists, leaving it permanently unpriced and billed at the fallback
 * estimate.
 *
 * Scoped to Claude ids, and to markers shaped like a token count, so an
 * unrecognised bracketed segment on any other provider is left alone.
 */
export function stripClaudeContextVariantSuffix(modelId: string): string {
  return /claude/i.test(modelId)
    ? modelId.replace(CLAUDE_CONTEXT_VARIANT_SUFFIX, "")
    : modelId;
}

/**
 * True for OpenAI models served only (or only fully) through the Responses API
 * (`/v1/responses`), so the chat client must route them to the Responses
 * transport instead of `/v1/chat/completions`:
 *
 * - "pro" reasoning models: `/chat/completions` returns `api_not_found_error`
 *   ("not a chat model"). "pro" is matched as a hyphen/slash-delimited token,
 *   so dated snapshots (`gpt-5.5-pro-2026-01-01`) are covered.
 * - the gpt-5.6 family (sol/terra/luna): reasoning is on by default and
 *   `/chat/completions` rejects function tools with any reasoning effort
 *   (400 api_validation_error: "use /v1/responses or set reasoning_effort to
 *   'none'"). Disabling reasoning would degrade the model, so route the whole
 *   family to Responses. "gpt-5.6" is matched up to a `-`/`.`/end boundary so
 *   tiers and dated snapshots are covered without matching e.g. `gpt-5.61`.
 */
export function requiresOpenAiResponsesApi(modelId: string): boolean {
  return (
    /(?:^|[-/])pro(?:[-/]|$)/i.test(modelId) ||
    /(?:^|\/)gpt-5\.6(?:$|[-.])/i.test(modelId)
  );
}

/**
 * True for `perplexity` models served by the Agent API rather than
 * chat-completions. The two catalogs are disjoint by construction: the Agent
 * API's ids are vendor-prefixed (`perplexity/glm-5.2`, `anthropic/…`,
 * see PERPLEXITY_AGENT_MODELS) while the chat-completions family is the bare
 * `sonar*` ids, so the slash is the discriminator.
 */
export function requiresPerplexityAgentApi(modelId: string): boolean {
  return modelId.includes("/");
}

/**
 * The Agent API base for a `perplexity` credential: the same host as the
 * chat-completions base (the provider's one configurable URL, default or
 * per-key), with the `/v1` that roots the Agent API's paths — the SDK then
 * appends `/responses` to reach its OpenAI-compatible alias.
 */
export function perplexityAgentApiBaseUrl(chatBaseUrl?: string | null): string {
  let base = chatBaseUrl || DEFAULT_PROVIDER_BASE_URLS.perplexity;
  // Trimmed by slicing rather than a `/\/+$/` replace: the base URL is
  // operator-supplied per key, and a backtracking anchored match on it is a
  // denial-of-service vector for a string of many slashes.
  while (base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  return `${base}/v1`;
}

/**
 * True for Anthropic models where thinking is on by default (Claude Opus 5,
 * Sonnet 5, Fable 5, Mythos 5, Mythos Preview): the model reasons — and bills
 * those tokens — on every request, but the API returns the thinking text only
 * when the request opts in with `thinking: {display: "summarized"}`. Matched
 * as substrings so dated snapshots (`claude-sonnet-5-20250929`) are covered.
 *
 * Models where thinking is off until requested (Opus 4.8/4.7, Sonnet 4.6 and
 * earlier) are deliberately excluded: turning thinking on there would add
 * cost, which is a product decision rather than a display fix.
 */
export function anthropicThinksByDefault(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return ANTHROPIC_DEFAULT_THINKING_MODEL_MARKERS.some((marker) =>
    id.includes(marker),
  );
}

const ANTHROPIC_UNCONDITIONAL_THINKING_MODEL_MARKERS = [
  "fable-5",
  "mythos-5",
  "mythos-preview",
];

const ANTHROPIC_DEFAULT_THINKING_MODEL_MARKERS = [
  "opus-5",
  "sonnet-5",
  // Everything that thinks unconditionally also thinks by default, so a new
  // Fable/Mythos generation is added in one place rather than two.
  ...ANTHROPIC_UNCONDITIONAL_THINKING_MODEL_MARKERS,
];

/**
 * True when a thinks-by-default Anthropic model accepts
 * `thinking: {type: "disabled"}`. Opus 5 and Sonnet 5 do (Opus 5 only at
 * effort high or below, which is the request default); the Fable/Mythos
 * class thinks unconditionally and 400s on `disabled` at any effort — the
 * only lever there is `output_config.effort`. Models that don't think by
 * default never need the field, so callers should gate on
 * {@link anthropicThinksByDefault} first.
 */
export function anthropicSupportsThinkingDisabled(modelId: string): boolean {
  const id = modelId.toLowerCase();
  return !ANTHROPIC_UNCONDITIONAL_THINKING_MODEL_MARKERS.some((marker) =>
    id.includes(marker),
  );
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
    moonshotai: "kimi",
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
    // Microsoft 365 Copilot exposes a single static pseudo-model (the Graph Chat
    // API has no model selection), so there is nothing to sync from models.dev
    "microsoft-365-copilot": null,
    perplexity: null,
    nvidia: null,
  };

/**
 * Absolute ceiling for a configured Ollama `num_ctx`, sitting comfortably above
 * the largest advertised context window in circulation. This is only a guard
 * against a runaway typo; the meaningful limit is the model's own
 * `contextLength`, which the update route enforces per row — except on rows
 * whose architectural length is unknown (proxy-discovered models), where this
 * is the only ceiling.
 *
 * Shared so the models-page form can mirror the server rule rather than letting
 * an out-of-range value reach the backend and come back as a bare 400.
 */
export const MAX_CONFIGURABLE_NUM_CTX = 10_000_000;

/** Ollama only ever honours a handful of stop sequences. */
export const MAX_STOP_SEQUENCES = 16;
export const MAX_STOP_SEQUENCE_LENGTH = 256;
