import { z } from "zod";
import type { ThinkingEffort } from "./thinking-effort";

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
  "voyage",
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
  "cohere:embeddings",
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
  "github-copilot:responses",
  "microsoft-365-copilot:chatCompletions",
  "archestra:chatCompletions",
  "voyage:embeddings",
]);

export const SupportedProviders = Object.values(SupportedProvidersSchema.enum);

/**
 * Providers whose direct-call transport is verified to forward
 * `application/pdf` file parts to the vendor API — the transports knowledge
 * OCR can run on. Membership is about the TRANSPORT, not the model:
 * `ollama-native`'s converter silently drops non-image file parts, so a
 * "vision" model there would transcribe nothing while appearing configured.
 * The OpenAI-compatible transports (azure, openrouter, vllm) serialize PDF
 * file parts faithfully; whether the endpoint's model accepts them is
 * endpoint-dependent and surfaces per document.
 */
export const OCR_PDF_INPUT_PROVIDERS: readonly SupportedProvider[] = [
  "anthropic",
  "openai",
  "gemini",
  "bedrock",
  "azure",
  "openrouter",
  "vllm",
];
export type SupportedProvider = z.infer<typeof SupportedProvidersSchema>;

/**
 * The wire formats a single provider can serve one model catalog over, spelled
 * as the provider spells them. Only GitHub Copilot publishes this per model
 * today (`supported_endpoints` on its `/models` entries), and it is the only
 * discriminator available there: its Codex and GPT-5.x models accept only
 * `/responses` while the rest accept only `/chat/completions`, and both
 * families use bare ids like `gpt-5.5` and `gpt-4o`, so — unlike Perplexity,
 * where a vendor prefix marks the Agent API — nothing about the id says which
 * surface a model belongs to. Persisted per model so the surface survives to
 * request time.
 */
export const ProviderEndpointSchema = z.enum([
  "/chat/completions",
  "/responses",
]);
export type SupportedProviderEndpoint = z.infer<typeof ProviderEndpointSchema>;

/**
 * True for providers that serve one model catalog over more than one wire
 * format, where the model id alone does not say which. Gates the per-model
 * surface lookup on the chat hot path so single-surface providers — every
 * other one — pay nothing for it.
 *
 * Perplexity is deliberately absent: it also serves two surfaces, but its
 * catalogs are disjoint by construction and `requiresPerplexityAgentApi`
 * reads the answer straight off the id, with no row to fetch.
 */
export function providerHasMultipleSurfaces(
  provider: SupportedProvider,
): boolean {
  return provider === "github-copilot";
}

/**
 * True when a model must be invoked through the Responses API — i.e. the
 * provider published its supported endpoints and `/chat/completions` was not
 * among them. Absent or empty data answers `false` so a model whose surface is
 * unknown keeps the chat-completions default rather than being routed to a
 * surface it may not serve.
 */
export function requiresResponsesApi(
  supportedEndpoints: readonly string[] | null | undefined,
): boolean {
  if (!supportedEndpoints || supportedEndpoints.length === 0) {
    return false;
  }
  return (
    supportedEndpoints.includes("/responses") &&
    !supportedEndpoints.includes("/chat/completions")
  );
}

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
  // Named for the generic path rather than the one engine: the `vllm` adapter
  // only speaks the OpenAI `/v1/chat/completions` shape, so every server
  // implementing it — llama.cpp, LM Studio, SGLang, TGI, LocalAI — runs
  // through this entry. Under the old "vLLM" label none of those operators had
  // a reason to open it. vLLM stays reachable through `providerSearchAliases`
  // and the picker's own subtext.
  vllm: "OpenAI-compatible",
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
  voyage: "Voyage AI",
};

/**
 * Extra terms a provider picker's search matches, beyond the entry's own
 * label. Nothing here renders — aliases only widen search.
 *
 * The `vllm` entry is the platform's generic OpenAI-compatible path: it holds
 * a base URL and talks `/v1/chat/completions`, so every self-hosted inference
 * server speaking that shape runs through it. Without aliases each of those is
 * reachable only by someone who already knows to look under "vLLM", which is
 * the discovery problem — an operator searches for the server they actually
 * run.
 *
 * Deliberately independent of the white-label display override: relabelling
 * the entry does not stop it serving llama.cpp, so the aliases survive a
 * rename.
 */
const providerSearchAliases: Partial<
  Record<SupportedProvider, readonly string[]>
> = {
  vllm: [
    "vLLM",
    "OpenAI compatible",
    "llama.cpp",
    "llamacpp",
    "LM Studio",
    "SGLang",
    "TGI",
    "text-generation-inference",
    "LocalAI",
    "self-hosted",
  ],
};

/**
 * The alias terms for a provider as one searchable string, ready to append to
 * a picker item's `searchText`. Empty for providers that need no aliases.
 */
export function providerSearchTerms(provider: SupportedProvider): string {
  return (providerSearchAliases[provider] ?? []).join(" ");
}

/**
 * Providers that serve embeddings only — they publish no chat/completion API at
 * all, so they exist in this enum purely to be selectable as a knowledge-base
 * embedding provider.
 *
 * `SupportedProvider` is otherwise a list of *chat* providers, and a good deal
 * of the platform (the model router, the connection page's proxy instructions,
 * tokenizers, cost limits) reasonably assumes every member can hold a
 * conversation. Rather than let those surfaces advertise a provider that would
 * 404 on every chat request, they filter on this set. The chat/embedding split
 * at the *model* level is separate and already handled by
 * `embeddingDimensions` — this set is the *provider*-level half of it.
 */
const EMBEDDING_ONLY_PROVIDER_LIST = [
  "voyage",
] as const satisfies ReadonlyArray<SupportedProvider>;

export const EMBEDDING_ONLY_PROVIDERS = new Set<SupportedProvider>(
  EMBEDDING_ONLY_PROVIDER_LIST,
);

export type EmbeddingOnlyProvider =
  (typeof EMBEDDING_ONLY_PROVIDER_LIST)[number];

/**
 * The providers that can actually hold a conversation — `SupportedProvider`
 * minus the embeddings-only ones. Chat-shaped exhaustive maps key off this so
 * adding a *chat* provider still breaks them (the point of those maps), while
 * an embeddings-only provider is not forced to invent a chat implementation it
 * does not have.
 */
export type ChatProvider = Exclude<SupportedProvider, EmbeddingOnlyProvider>;

/**
 * True when the provider publishes a chat/completion API. Chat-only surfaces
 * gate on this so an embeddings-only provider is never offered for a
 * conversation, a proxy endpoint, or a model-router mapping.
 */
export function providerSupportsChat(
  provider: SupportedProvider,
): provider is ChatProvider {
  return !EMBEDDING_ONLY_PROVIDERS.has(provider);
}

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
 * Providers where a provider key IS a server, not just a credential: each key
 * carries its own base URL and only the models that server happens to host, so
 * two keys of the same provider can serve disjoint catalogs.
 *
 * This is the normal shape for self-hosted inference — `vllm serve` runs one
 * model per process, so an operator hosting several models runs several servers
 * — and it is what makes request-time endpoint selection model-dependent:
 * sending a model to a sibling server that does not host it is a guaranteed
 * upstream 404, so resolution prefers whichever key's endpoint actually serves
 * the requested model (see `LlmProviderApiKeyModel.findKeyServingModel`).
 *
 * Deliberately NOT every provider: for a credential-style provider (OpenAI,
 * Anthropic, …) every key reaches the same catalog, so switching keys would
 * only change which account is billed — never whether the call can succeed.
 */
const PROVIDERS_WITH_ENDPOINT_LOCAL_MODELS = new Set<SupportedProvider>([
  "vllm",
  "ollama",
  "ollama-native",
  // An Azure key names one AI Foundry resource, and a deployment exists only
  // within the resource it was created in.
  "azure",
  // Points at one other Archestra instance's proxy, which exposes that
  // instance's models.
  "archestra",
]);

export function providerHasEndpointLocalModels(
  provider: SupportedProvider,
): boolean {
  return PROVIDERS_WITH_ENDPOINT_LOCAL_MODELS.has(provider);
}

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
  // OpenAI-wire on chat completions, plus a native Responses surface that the
  // router hands Responses-only models to directly (see
  // `providerHasMultipleSurfaces`). Its credential is per-user, so it is
  // routable only through the owner's own personal virtual key.
  "github-copilot",
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
  // Embeddings-only: both the text (`/embeddings`) and multimodal
  // (`/multimodalembeddings`) endpoints hang off this root.
  voyage: "https://api.voyageai.com/v1",
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
  // Embeddings-only, so these mark the best *embedding* model rather than a
  // chat one — the retrieval-quality flagship first.
  voyage: ["voyage-4-large", "voyage-multimodal-3.5", "voyage-4"],
};

/**
 * Default model for each provider when no synced "best" model is available.
 * Using Record<SupportedProvider, string> ensures a compile-time error when a new provider is added.
 */
export const DEFAULT_MODELS: Record<SupportedProvider, string> = {
  // Embeddings-only: never used to start a conversation, only as the fallback
  // embedding model when no synced "best" row exists.
  voyage: "voyage-4",
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
 * - Codex models: OpenAI serves the coding-specialized `gpt-*-codex` family
 *   through Responses rather than Chat Completions. The suffix boundary also
 *   covers variants such as `-mini`, `-max`, and dated snapshots.
 */
export function requiresOpenAiResponsesApi(modelId: string): boolean {
  return (
    /(?:^|[-/])pro(?:[-/]|$)/i.test(modelId) ||
    /(?:^|\/)gpt-5\.6(?:$|[-.])/i.test(modelId) ||
    /(?:^|\/)gpt-[^/]+-codex(?:$|[-.])/i.test(modelId)
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
 * True when a chosen reasoning depth is worth offering for an Anthropic model.
 *
 * Deliberately the same set as {@link anthropicThinksByDefault}, and delegating
 * rather than listing markers again so the two cannot drift. The reasoning is
 * that `output_config.effort` only *means* reasoning depth while thinking is
 * on: Opus 4.5–4.8 and Sonnet 4.6 accept the field but keep thinking off until
 * a request asks for it, so a depth there would move token spend without
 * producing any of the reasoning the control names.
 *
 * Reaching them would mean sending `thinking: {type: "adaptive"}` alongside the
 * effort, which the display wrapper in `clients/llm-client.ts` currently treats
 * as a caller opting out of summaries — a bigger change than this control.
 *
 * Older models (Sonnet 4.5, Haiku 4.5 and earlier) reject the field outright.
 */
export function anthropicSupportsThinkingEffort(modelId: string): boolean {
  return anthropicThinksByDefault(modelId);
}

/**
 * The `output_config.effort` a chosen depth maps to, or null when the model is
 * outside {@link anthropicSupportsThinkingEffort}.
 *
 * Mapped by name. Anthropic's own default is `high` rather than `medium`, but
 * that is auto's business, not this function's: a conversation nobody has
 * touched never reaches here, so the levels can mean what they say instead of
 * being shifted to keep one of them standing in for "unchanged".
 */
export function anthropicEffortForThinkingEffort(
  modelId: string,
  effort: ThinkingEffort,
): ThinkingEffort | null {
  return anthropicSupportsThinkingEffort(modelId) ? effort : null;
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
 * models.dev providers whose model *list* cannot come from models.dev — which
 * models a credential can reach is decided by the subscription or deployment
 * behind it — but whose models.dev catalog is still the best source of
 * per-model metadata (modalities, prices, limits) for the models the
 * provider's own endpoint reports.
 *
 * Consulted only when enriching provider-fetched models during model sync;
 * never used to create model rows directly from models.dev (that stays
 * governed by MODELS_DEV_PROVIDER_MAP, where these providers map to null).
 */
export const MODELS_DEV_ENRICHMENT_PROVIDER_MAP: Record<
  string,
  SupportedProvider
> = {
  "github-copilot": "github-copilot",
  azure: "azure",
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

/**
 * Absolute ceiling for an admin-set context window or max-output-token count on
 * the models page. Like {@link MAX_CONFIGURABLE_NUM_CTX} it is a runaway-typo
 * guard rather than a claim about any real model: these overrides exist because
 * a provider reported nothing, so there is no per-row limit to check them
 * against.
 *
 * Shared so the models-page form mirrors the server rule instead of letting an
 * out-of-range value reach the backend and come back as a bare 400.
 */
export const MAX_CUSTOM_MODEL_TOKEN_LIMIT = 10_000_000;

/** Ollama only ever honours a handful of stop sequences. */
export const MAX_STOP_SEQUENCES = 16;
export const MAX_STOP_SEQUENCE_LENGTH = 256;
