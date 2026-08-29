"use client";

import {
  type archestraApiTypes,
  BEDROCK_REGIONS,
  bedrockRegionFromBaseUrl,
  bedrockRuntimeBaseUrl,
  DEFAULT_BEDROCK_REGION,
  DEFAULT_PROVIDER_BASE_URLS,
  E2eTestId,
  isCredentialLevelSubscriptionProvider,
  isProviderApiKeyOptional,
  isSelfHostedProvider,
  providerRequiresPerUserCredential,
  SUBSCRIPTION_CREDENTIALS,
  subscriptionKindForProvider,
} from "@archestra/shared";
import { CheckCircle2, ChevronDown, Trash2 } from "lucide-react";
import Link from "next/link";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { type UseFormReturn, useFieldArray } from "react-hook-form";
import { SCOPE_META, scopeLabel } from "@/components/scope-vocabulary";
import { SubscriptionSignIn } from "@/components/subscription-sign-in";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature, useProviderBaseUrls } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { providerSearchHaystack } from "@/lib/provider-search";
import { useTeams } from "@/lib/teams/team.query";
import { cn } from "@/lib/utils";
import { LlmProviderOptionLabel } from "./llm-provider-select-items";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { SearchableSelect } from "./ui/searchable-select";
import { SecretInput } from "./ui/secret-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Switch } from "./ui/switch";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";

const ExternalSecretSelector = lazy(
  () =>
    // biome-ignore lint/style/noRestrictedImports: lazy loading
    import("@/components/external-secret-selector.ee"),
);
const InlineVaultSecretSelector = lazy(
  () =>
    // biome-ignore lint/style/noRestrictedImports: lazy loading
    import("@/components/inline-vault-secret-selector.ee"),
);

type CreateLlmProviderApiKeyBody =
  archestraApiTypes.CreateLlmProviderApiKeyData["body"];

export type LlmProviderApiKeyFormValues = {
  name: string;
  provider: CreateLlmProviderApiKeyBody["provider"];
  apiKey: string | null;
  baseUrl: string | null;
  inferenceBaseUrl: string | null;
  /** Edited as an array of rows; serialized to Record<string, string> on submit. */
  extraHeaders: Array<{ name: string; value: string }>;
  scope: NonNullable<CreateLlmProviderApiKeyBody["scope"]>;
  teamId: string | null;
  vaultSecretPath: string | null;
  vaultSecretKey: string | null;
  isPrimary: boolean;
  /**
   * Bedrock auth method selector:
   * - "api-key": Bearer API key (bedrock-api-key-... / ABSK...)
   * - "sigv4": static AWS access keys (Access Key ID + Secret + optional Session Token)
   * - "iam": IAM role via service account / instance profile (server-configured via ARCHESTRA_BEDROCK_IAM_AUTH_ENABLED)
   */
  bedrockAuthMethod: "api-key" | "sigv4" | "iam";
  awsAccessKeyId: string | null;
  awsSecretAccessKey: string | null;
  awsSessionToken: string | null;
  /**
   * Auth mode selector for providers that accept either credential type:
   * - "api-key": a standard provider API key.
   * - "subscription": reuse the vendor subscription via its device flow
   *   (stores an OAuth credential instead of a key). Ignored for providers with
   *   no credential-level subscription.
   */
  authMethod: "api-key" | "subscription";
};

/** Convert the form's array shape to the API's Record shape, dropping empty-name rows. */
export function serializeExtraHeaders(
  rows: LlmProviderApiKeyFormValues["extraHeaders"],
): Record<string, string> | null {
  const trimmed = rows
    .map((row) => ({ name: row.name.trim(), value: row.value }))
    .filter((row) => row.name.length > 0);
  if (trimmed.length === 0) return null;
  const result: Record<string, string> = {};
  for (const row of trimmed) {
    result[row.name] = row.value;
  }
  return result;
}

/** Convert a Record back into the form's array shape, used when editing an existing key. */
export function deserializeExtraHeaders(
  record: Record<string, string> | null | undefined,
): LlmProviderApiKeyFormValues["extraHeaders"] {
  if (!record) return [];
  return Object.entries(record).map(([name, value]) => ({ name, value }));
}

export type LlmProviderApiKeyResponse =
  archestraApiTypes.GetLlmProviderApiKeysResponses["200"][number];

function isOllamaProvider(provider: string): boolean {
  return provider === "ollama" || provider === "ollama-native";
}

/**
 * Ollama ships as two providers because the transports differ on the wire, but
 * they are one product behind one base URL. The picker shows a single "Ollama"
 * entry plus a separate transport control, so one of the pair stands in for both
 * in the provider list.
 *
 * `ollama-native` is the better general default — it carries the per-model
 * parameters `/v1` silently discards — but it cannot do embeddings, so for an
 * embedding key the OpenAI-compatible transport is the only valid one and must
 * be the entry shown. Collapsing to native unconditionally made Ollama
 * unselectable in the embedding dialog.
 */
function ollamaTransportForContext(
  forEmbedding: boolean,
): CreateLlmProviderApiKeyBody["provider"] {
  return forEmbedding ? "ollama" : "ollama-native";
}

/** Both Ollama transports, in the order the transport control lists them. */
const OLLAMA_TRANSPORTS = [
  "ollama-native",
  "ollama",
] as const satisfies readonly CreateLlmProviderApiKeyBody["provider"][];

const OLLAMA_TRANSPORT_OPTIONS = [
  { value: "ollama-native", label: "Native" },
  { value: "ollama", label: "OpenAI-compatible" },
] as const satisfies readonly {
  value: CreateLlmProviderApiKeyBody["provider"];
  label: string;
}[];

const PROVIDER_CONFIG: Record<
  CreateLlmProviderApiKeyBody["provider"],
  {
    name: string;
    icon: string;
    placeholder: string;
    enabled: boolean;
    consoleUrl: string;
    consoleName: string;
    /**
     * A function when the blurb names the provider itself, so it can render
     * the organization's own label for it; a plain string otherwise.
     */
    description?: string | ((providerLabel: string) => string);
    /**
     * A second line under the entry's name in the provider picker, for an
     * entry whose name does not say what it covers.
     */
    optionSubtext?: string;
    baseUrlRequired?: boolean;
    /** Whether this provider can be used for embeddings (defaults to true). */
    supportsEmbeddings?: boolean;
  }
> = {
  anthropic: {
    name: "Anthropic",
    icon: "/icons/anthropic.png",
    placeholder: "sk-ant-...",
    enabled: true,
    consoleUrl: "https://console.anthropic.com/settings/keys",
    consoleName: "Anthropic Console",
  },
  openai: {
    name: "OpenAI",
    icon: "/icons/openai.png",
    placeholder: "sk-...",
    enabled: true,
    consoleUrl: "https://platform.openai.com/api-keys",
    consoleName: "OpenAI Platform",
  },
  gemini: {
    name: "Gemini",
    icon: "/icons/gemini.png",
    placeholder: "AIza...",
    enabled: true,
    consoleUrl: "https://aistudio.google.com/app/apikey",
    consoleName: "Google AI Studio",
  },
  cerebras: {
    name: "Cerebras",
    icon: "/icons/cerebras.png",
    placeholder: "csk-...",
    enabled: true,
    consoleUrl: "https://cloud.cerebras.ai/platform",
    consoleName: "Cerebras Cloud",
  },
  voyage: {
    name: "Voyage AI",
    icon: "/icons/voyage.png",
    placeholder: "pa-...",
    enabled: true,
    consoleUrl: "https://dashboard.voyageai.com/organization/api-keys",
    consoleName: "Voyage AI Dashboard",
    description:
      "Embeddings only. Voyage serves no chat models, so this key is used to embed knowledge-base documents rather than to answer prompts.",
  },
  cohere: {
    name: "Cohere",
    icon: "/icons/cohere.png",
    placeholder: "...",
    enabled: true,
    consoleUrl: "https://dashboard.cohere.com/api-keys",
    consoleName: "Cohere Dashboard",
  },
  mistral: {
    name: "Mistral AI",
    icon: "/icons/mistral.png",
    placeholder: "...",
    enabled: true,
    consoleUrl: "https://console.mistral.ai/api-keys",
    consoleName: "Mistral AI Console",
  },
  perplexity: {
    name: "Perplexity AI",
    icon: "/icons/perplexity.png",
    placeholder: "pplx-...",
    enabled: true,
    consoleUrl: "https://www.perplexity.ai/settings/api",
    consoleName: "Perplexity Settings",
  },
  groq: {
    name: "Groq",
    icon: "/icons/groq.png",
    placeholder: "gsk_...",
    enabled: true,
    consoleUrl: "https://console.groq.com/keys",
    consoleName: "Groq Console",
  },
  xai: {
    name: "xAI",
    icon: "/icons/xai.png",
    placeholder: "xai-...",
    enabled: true,
    consoleUrl: "https://x.ai/api",
    consoleName: "xAI",
  },
  openrouter: {
    name: "OpenRouter",
    icon: "/icons/openrouter.png",
    placeholder: "sk-or-v1-...",
    enabled: true,
    consoleUrl: "https://openrouter.ai/keys",
    consoleName: "OpenRouter",
  },
  vllm: {
    // This entry is the generic OpenAI-compatible path, not the vLLM project's
    // own integration: the adapter only speaks `/v1/chat/completions`, so every
    // server implementing that shape runs through it. The provider id stays
    // `vllm` — it is what every stored key, env var and proxy route already
    // says — while the label names what the entry actually covers.
    name: "OpenAI-compatible",
    icon: "/icons/vllm.png",
    placeholder: "optional-api-key",
    enabled: true,
    consoleUrl: "https://docs.vllm.ai/",
    consoleName: "vLLM Docs",
    optionSubtext: "vLLM, llama.cpp, LM Studio, SGLang, TGI, LocalAI",
    description:
      "For any server that exposes an OpenAI-compatible /v1 API — vLLM, llama.cpp, LM Studio, SGLang, TGI, LocalAI, and others. Point the Base URL at your server; most self-hosted deployments need no API key.",
    // A key here is a server, not an account, so the endpoint is the whole
    // point of the form and belongs above "advanced settings" rather than
    // hidden inside it. It is also unusable when blank — there is no default
    // endpoint, so an unset base URL routes to api.openai.com.
    baseUrlRequired: true,
  },
  ollama: {
    name: "Ollama (OpenAI-compatible)",
    icon: "/icons/ollama.png",
    placeholder: "optional-api-key",
    enabled: true,
    consoleUrl: "https://ollama.ai/",
    consoleName: "Ollama",
    description: (name) =>
      `For self-hosted ${name}, an API key is not required.`,
  },
  "ollama-native": {
    name: "Ollama (Native)",
    icon: "/icons/ollama.png",
    placeholder: "optional-api-key",
    enabled: true,
    consoleUrl: "https://ollama.ai/",
    consoleName: "Ollama",
    description: (name) =>
      `Native /api/chat transport — lets you set num_ctx, num_predict, top_k, thinking effort, and other ${name} parameters. An API key is not required for self-hosted ${name}.`,
    supportsEmbeddings: false,
  },
  zhipuai: {
    name: "Zhipu AI",
    icon: "/icons/zhipuai.png",
    placeholder: "...",
    enabled: true,
    consoleUrl: "https://z.ai/model-api",
    consoleName: "Zhipu AI Platform",
  },
  deepseek: {
    name: "DeepSeek",
    icon: "/icons/deepseek.png",
    placeholder: "sk-...",
    enabled: true,
    consoleUrl: "https://platform.deepseek.com/api_keys",
    consoleName: "DeepSeek Platform",
  },
  archestra: {
    // white-label-ok: names the `archestra` upstream LLM provider a deployment connects to, not this deployment's own brand
    name: "Archestra",
    icon: "/icons/archestra.png",
    placeholder: "arch_...",
    enabled: true,
    consoleUrl: "https://archestra.ai/",
    // white-label-ok: names the `archestra` upstream LLM provider a deployment connects to, not this deployment's own brand
    consoleName: "Archestra",
    baseUrlRequired: true,
    description: (name) =>
      // The upstream instance is named by whatever this deployment calls the
      // provider, so a renamed one reads consistently here too.
      `Route through another ${name} instance. On that instance, create a virtual API key for its LLM Proxy. Set the Base URL to that instance's model router (e.g. https://your-archestra/v1/model-router) and paste the virtual API key below.`,
  },
  kimi: {
    name: "Moonshot (Kimi)",
    icon: "/icons/kimi.png",
    placeholder: "sk-...",
    enabled: true,
    consoleUrl: "https://platform.moonshot.ai/console/api-keys",
    consoleName: "Moonshot AI Platform",
  },
  bedrock: {
    name: "AWS Bedrock",
    icon: "/icons/bedrock.png",
    // The field is already labelled "API Key" and the prefixes below are the
    // literal shapes AWS issues, so the provider's name adds nothing here —
    // and would be the org's own name for it, which AWS keys do not carry.
    placeholder: "API key (bedrock-api-key-... / ABSK...)",
    enabled: true,
    consoleUrl: "https://console.aws.amazon.com/bedrock",
    consoleName: "AWS Console",
    // No baseUrlRequired: Bedrock asks for a region instead. AWS publishes no
    // "base URL" for Bedrock — the SDK builds the endpoint from the region — so
    // demanding one was a dead end. The region picker writes the runtime
    // endpoint, and the custom-endpoint field stays available underneath it.
  },
  minimax: {
    name: "MiniMax",
    icon: "/icons/minimax.png",
    placeholder: "sk-...",
    enabled: true,
    consoleUrl: "https://www.minimax.io/",
    consoleName: "MiniMax Platform",
  },
  azure: {
    name: "Azure AI Foundry",
    icon: "/icons/azure.png",
    placeholder: "your-azure-openai-api-key",
    enabled: true,
    consoleUrl:
      "https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/OpenAI",
    consoleName: "Azure Portal",
    description:
      "Use your Azure OpenAI or Foundry URL for deployment discovery. If runtime traffic uses a different Azure OpenAI endpoint, set the optional inference URL below.",
  },
  "github-copilot": {
    name: "GitHub Copilot",
    icon: "/icons/github-copilot.png",
    placeholder: "Auto-filled after sign in (or paste a gho_… token)",
    enabled: true,
    consoleUrl: "https://github.com/settings/copilot",
    consoleName: "GitHub Copilot Settings",
    // "Sign in with GitHub" names the identity provider, not this one, so it
    // stays literal.
    description: (name) =>
      `No API key to find — just use Sign in with GitHub below to connect your ${name} subscription. Keys are per-user: everyone using a ${name} model signs in with their own GitHub account.`,
    // Copilot only exposes chat-completion models through Archestra.
    supportsEmbeddings: false,
  },
  "microsoft-365-copilot": {
    name: "Microsoft 365 Copilot",
    icon: "/icons/microsoft-365-copilot.png",
    placeholder: "Auto-filled after sign in",
    enabled: true,
    consoleUrl: "https://m365.cloud.microsoft/chat",
    consoleName: "Microsoft 365 Copilot",
    // The licence is a Microsoft SKU and keeps its real name; the second
    // mention is this provider, so it follows the organization's label.
    description: (name) =>
      `No API key to find — just use Sign in with Microsoft below to connect your work account. Requires a Microsoft 365 Copilot license; keys are per-user, so everyone using ${name} signs in with their own account.`,
    // The Graph Chat API is text-only chat; no embeddings.
    supportsEmbeddings: false,
  },
} as const;

export { PROVIDER_CONFIG };

export const LLM_PROVIDER_API_KEY_PLACEHOLDER = "••••••••••••••••";

interface LlmProviderApiKeyFormProps {
  /** Layout mode for the form container. */
  mode?: "full" | "compact";
  /** Whether to show the provider console/help link below the credential input. */
  showConsoleLink?: boolean;
  /** Existing key being edited; omitted for create flows. */
  existingKey?: LlmProviderApiKeyResponse;
  /** Visible sibling keys used for primary-key defaults and conflicts. */
  existingKeys?: LlmProviderApiKeyResponse[];
  /** Parent-owned React Hook Form instance. */
  form: UseFormReturn<LlmProviderApiKeyFormValues>;
  /** Disables interactive controls while a mutation is pending. */
  isPending?: boolean;
  /** Whether Gemini direct API keys are disabled in favor of Vertex AI. */
  geminiVertexAiEnabled?: boolean;
  /** Whether Bedrock IAM auth is enabled, making direct API key entry optional. */
  bedrockIamAuthEnabled?: boolean;
  /** Prevent changing the selected provider. */
  disableProvider?: boolean;
  /** Optional allowlist for provider selection. */
  allowedProviders?: CreateLlmProviderApiKeyBody["provider"][];
  /** Hide scope and primary-key controls when the parent fixes those values. */
  hideScopeAndPrimary?: boolean;
  /** When true, providers without embedding support are disabled in the picker. */
  forEmbedding?: boolean;
  /** Whether personal subscription credential modes can be configured. */
  allowPersonalSubscriptions?: boolean;
  /** Dedicated credential flow shown by the create dialog. */
  credentialMode?: "api-key" | "subscription";
  /** The caller is satisfying an agent pin that requires this exact subscription kind. */
  requiresExactSubscriptionCredential?: boolean;
  /** Hide optional API-key fields behind an Advanced settings disclosure. */
  progressive?: boolean;
  /** Called when a subscription sign-in returns a credential. */
  onSubscriptionCredential?: (credential: string) => void | Promise<void>;
}

export function LlmProviderApiKeyForm({
  mode = "full",
  showConsoleLink = true,
  existingKey,
  existingKeys,
  form,
  isPending = false,
  geminiVertexAiEnabled = false,
  bedrockIamAuthEnabled = false,
  disableProvider = false,
  allowedProviders,
  hideScopeAndPrimary = false,
  forEmbedding = false,
  allowPersonalSubscriptions = true,
  credentialMode,
  requiresExactSubscriptionCredential = false,
  progressive = false,
  onSubscriptionCredential,
}: LlmProviderApiKeyFormProps) {
  const appName = useAppName();
  const byosEnabled = useFeature("byosEnabled");
  const azureOpenAiEntraIdEnabled = useFeature("azureOpenAiEntraIdEnabled");
  const anthropicWifEnabled = useFeature("anthropicWifEnabled");
  const { data: providerBaseUrls } = useProviderBaseUrls();
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: isLlmProviderApiKeyAdmin } = useHasPermissions({
    llmProviderApiKey: ["admin"],
  });
  const { data: teams = [] } = useTeams();
  const isEditMode = Boolean(existingKey);
  const isSubscriptionFlow = credentialMode === "subscription";
  const [advancedSettingsOpen, setAdvancedSettingsOpen] = useState(false);
  const showAdvancedSettings = !progressive || advancedSettingsOpen;

  const provider = form.watch("provider");
  const apiKey = form.watch("apiKey");
  const scope = form.watch("scope");
  const teamId = form.watch("teamId");
  const bedrockAuthMethod = form.watch("bedrockAuthMethod");
  const isBedrockSigV4 =
    provider === "bedrock" && bedrockAuthMethod === "sigv4";
  const baseUrl = form.watch("baseUrl");
  const isBedrock = provider === "bedrock";
  const isVllm = provider === "vllm";
  const authMethod = form.watch("authMethod");
  const providerSubscriptionKind = subscriptionKindForProvider(provider);
  // Credential-level subscription mode (e.g. ChatGPT on `openai`): the provider
  // also takes plain API keys, so the auth-method tabs decide which credential
  // this key holds. It then behaves like the per-user Copilot providers —
  // personal scope only, "Sign in" instead of a key field.
  const isCredentialSubscriptionMode =
    isCredentialLevelSubscriptionProvider(provider) &&
    authMethod === "subscription";

  const extraHeadersFieldArray = useFieldArray({
    control: form.control,
    name: "extraHeaders",
  });

  const hasApiKeyChanged =
    apiKey !== LLM_PROVIDER_API_KEY_PLACEHOLDER && apiKey !== "";
  // GitHub Copilot hides the raw token field — a credential exists only when an
  // existing key is being edited or the user just signed in (a real token is
  // captured). Note: `apiKey` defaults to `null` on create, which `hasApiKeyChanged`
  // treats as "changed" — so check for an actual token here, not that flag, or
  // the "connected" card would show before sign-in.
  const hasCopilotCredential =
    isEditMode || (!!apiKey && apiKey !== LLM_PROVIDER_API_KEY_PLACEHOLDER);
  const providerConfig = PROVIDER_CONFIG[provider];
  const providerCatalog = useModelProviderCatalog();
  /**
   * What to call this provider in copy. Every sentence naming the provider
   * itself uses it, so an organization that renamed one does not read about a
   * provider it does not have. Vendor products and identifiers stay literal —
   * "AWS", "Azure OpenAI", `bedrock:InvokeModel` — because renaming those would
   * point at things that do not exist.
   */
  const providerLabel = providerCatalog.label(provider);
  const providerBlurb =
    typeof providerConfig.description === "function"
      ? providerConfig.description(providerLabel)
      : providerConfig.description;
  // The auto-filled key name follows the selected credential type, so choosing
  // ChatGPT Subscription renames the key from "OpenAI" to "ChatGPT Subscription".
  const defaultKeyName =
    isCredentialSubscriptionMode && providerSubscriptionKind
      ? SUBSCRIPTION_CREDENTIALS[providerSubscriptionKind].label
      : providerLabel;
  const isBaseUrlRequired =
    providerConfig.baseUrlRequired && !providerBaseUrls?.[provider];
  /**
   * Where the Base URL field belongs. For a self-hosted provider the endpoint
   * *is* the credential — nothing about the key identifies which server it
   * reaches — so it is a primary field and sits above "Advanced settings" with
   * the rest of them, whether or not it is strictly required. Everywhere else
   * the base URL only overrides a working default, which is what advanced
   * means. Bedrock is deliberately excluded: its primary field is the region,
   * and the endpoint that region writes stays advanced.
   */
  const showBaseUrlUpFront =
    !isBedrock && (isBaseUrlRequired || isSelfHostedProvider(provider));

  // Bedrock's effective region, in the same precedence order the backend's
  // getBedrockRegion applies: this key's own endpoint, then the server-wide
  // Bedrock endpoint, then the SDK default. Showing the resolved value means the
  // picker always reflects the region the key will really run against, so
  // leaving it untouched can't silently mean something else.
  const bedrockRegion =
    bedrockRegionFromBaseUrl(baseUrl) ??
    bedrockRegionFromBaseUrl(providerBaseUrls?.bedrock) ??
    DEFAULT_BEDROCK_REGION;
  // A custom endpoint carrying no recognizable region: the backend falls back to
  // the default region, which is the trap worth naming out loud in the UI.
  const hasUnresolvedBedrockRegion =
    isBedrock && Boolean(baseUrl) && bedrockRegionFromBaseUrl(baseUrl) === null;

  const allowedProviderSet = useMemo(
    () =>
      new Set<CreateLlmProviderApiKeyBody["provider"]>(
        (
          allowedProviders ??
          (Object.keys(
            PROVIDER_CONFIG,
          ) as CreateLlmProviderApiKeyBody["provider"][])
        ).filter(
          (candidate) =>
            allowPersonalSubscriptions ||
            !providerRequiresPerUserCredential(candidate),
        ),
      ),
    [allowedProviders, allowPersonalSubscriptions],
  );
  // The endpoint to suggest when the app runs in Docker. Derived from the
  // provider's own default so it matches the transport in play — vLLM has no
  // default endpoint at all, so it gets the advice without a concrete example.
  const dockerBaseUrlExample = DEFAULT_PROVIDER_BASE_URLS[provider]?.replace(
    "localhost",
    "host.docker.internal",
  );
  // The transports a caller-supplied `allowedProviders` leaves open. The pair is
  // one product with one credential, so a caller naming either one gets the
  // single collapsed "Ollama" entry — but it must resolve to a transport that
  // caller actually allows, or the entry renders permanently disabled.
  const allowedOllamaTransports = useMemo(
    (): CreateLlmProviderApiKeyBody["provider"][] =>
      OLLAMA_TRANSPORTS.filter((key) => allowedProviderSet.has(key)),
    [allowedProviderSet],
  );
  // Which of the two Ollama transports represents "Ollama" in the provider list:
  // the context's preferred transport when it is open, otherwise whichever one
  // the caller left.
  const ollamaListedTransport = useMemo(() => {
    const preferred = ollamaTransportForContext(forEmbedding);
    return allowedOllamaTransports.includes(preferred)
      ? preferred
      : (allowedOllamaTransports[0] ?? preferred);
  }, [allowedOllamaTransports, forEmbedding]);
  // Embeddings only work on the `/v1` transport, and a caller that allows just
  // one transport has already made the choice — in both cases there is nothing
  // to pick, and offering the control would let the form produce a key the
  // caller's own setup instructions do not describe.
  // The two Ollama transports collapse to one entry, so it drops the built-in
  // "(Native)" / "(OpenAI-compatible)" suffix — unless an admin renamed the
  // listed transport, in which case their name is what belongs there.
  const collapsedOllamaLabel =
    providerCatalog.label(ollamaListedTransport) ===
    PROVIDER_CONFIG[ollamaListedTransport].name
      ? "Ollama"
      : providerCatalog.label(ollamaListedTransport);

  const showOllamaTransport =
    isOllamaProvider(provider) &&
    !forEmbedding &&
    allowedOllamaTransports.length > 1;
  const showProviderField = !(progressive && allowedProviderSet.size === 1);
  /**
   * The provider picker's items, sorted by the label the organization actually
   * sees. `searchText` carries the entry's aliases on top of its label so a
   * generic entry is reachable by the product the operator runs — searching
   * "LM Studio" finds the OpenAI-compatible entry that serves it.
   */
  const providerOptions = useMemo(
    () =>
      Object.entries(PROVIDER_CONFIG)
        // Personal subscription-only providers do not belong in the API-key
        // flow. The two Ollama transports are one product and collapse to a
        // single provider entry.
        .filter(
          ([key]) =>
            (allowPersonalSubscriptions ||
              !providerRequiresPerUserCredential(
                key as CreateLlmProviderApiKeyBody["provider"],
              )) &&
            (!isOllamaProvider(key) || key === ollamaListedTransport),
        )
        // Providers the admins turned off are not offered. The one already
        // selected stays in the list even when hidden, so an existing key's
        // disabled trigger still renders its own provider.
        .filter(
          ([key]) =>
            key === provider ||
            !providerCatalog.isHidden(
              key as CreateLlmProviderApiKeyBody["provider"],
            ),
        )
        .map(([key, config]) => {
          const providerKey = key as CreateLlmProviderApiKeyBody["provider"];
          return {
            providerKey,
            config,
            name:
              key === ollamaListedTransport
                ? collapsedOllamaLabel
                : providerCatalog.label(providerKey),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(({ providerKey, config, name }) => {
          const isGeminiDisabledByVertexAi =
            providerKey === "gemini" && geminiVertexAiEnabled;
          const isBedrockDisabledByIamAuth =
            providerKey === "bedrock" && bedrockIamAuthEnabled;
          const isEmbeddingUnsupported =
            forEmbedding && config.supportsEmbeddings === false;
          // Why the entry cannot be picked outranks what it covers, so the
          // embedding notice takes the one subtext line when both apply.
          const subtext = isEmbeddingUnsupported
            ? "Not supported for embeddings"
            : config.optionSubtext;

          return {
            value: providerKey,
            label: name,
            searchText: providerSearchHaystack({
              provider: providerKey,
              labels: [name, subtext],
            }),
            disabled:
              !allowedProviderSet.has(providerKey) ||
              !config.enabled ||
              isGeminiDisabledByVertexAi ||
              isBedrockDisabledByIamAuth ||
              isEmbeddingUnsupported,
            content: (
              <LlmProviderOptionLabel
                icon={config.icon}
                name={name}
                subtext={subtext}
                showComingSoon={!config.enabled}
                showGeminiVertexAiBadge={isGeminiDisabledByVertexAi}
                showBedrockIamBadge={isBedrockDisabledByIamAuth}
              />
            ),
            // The trigger is one line tall, so the selected entry drops the
            // subtext and the badges that only explain a disabled option.
            selectedContent: (
              <LlmProviderOptionLabel icon={config.icon} name={name} />
            ),
          };
        }),
    [
      allowPersonalSubscriptions,
      allowedProviderSet,
      bedrockIamAuthEnabled,
      collapsedOllamaLabel,
      forEmbedding,
      geminiVertexAiEnabled,
      ollamaListedTransport,
      provider,
      providerCatalog,
    ],
  );
  const showConfiguredStyling = isEditMode && !hasApiKeyChanged;

  const existingPrimaryKey = useMemo(() => {
    if (!existingKeys) {
      return null;
    }

    const otherKeys = existingKey
      ? existingKeys.filter((key) => key.id !== existingKey.id)
      : existingKeys;

    return (
      otherKeys.find(
        (key) =>
          key.provider === provider &&
          key.scope === scope &&
          (scope !== "team" || key.teamId === teamId) &&
          key.isPrimary,
      ) ?? null
    );
  }, [existingKey, existingKeys, provider, scope, teamId]);

  const hasAnyKeyForProvider = useMemo(() => {
    if (!existingKeys) {
      return false;
    }

    return existingKeys.some(
      (key) =>
        key.provider === provider &&
        key.scope === scope &&
        (scope !== "team" || key.teamId === teamId) &&
        !key.isSystem,
    );
  }, [existingKeys, provider, scope, teamId]);

  // Per-user-credential providers (GitHub Copilot) hold an individual's token,
  // so keys are personal-only — each user connects their own account. The
  // OpenAI "ChatGPT subscription" auth mode is the same shape.
  const isPerUserProvider = providerRequiresPerUserCredential(provider);
  const isPerUserCredential = isPerUserProvider || isCredentialSubscriptionMode;
  // The subscription this form is currently connecting, if any: implied by the
  // provider when it is per-user outright, chosen by the auth-method tabs when
  // the provider also accepts API keys. Drives every piece of vendor copy below.
  const activeSubscriptionKind = isPerUserCredential
    ? providerSubscriptionKind
    : null;
  const connectCopy = activeSubscriptionKind
    ? SUBSCRIPTION_CREDENTIALS[activeSubscriptionKind].connect
    : null;
  // BYOS Vault is intentionally read-only: Archestra can resolve references
  // but cannot write or rotate an OAuth credential in the customer's Vault.
  // Keep the dedicated connect surfaces open long enough to explain the
  // limitation, but never start a flow whose completion cannot be saved.
  const subscriptionUnavailableWithByos =
    Boolean(byosEnabled) && activeSubscriptionKind !== null;
  const subscriptionHasApiKeyAlternative = activeSubscriptionKind
    ? SUBSCRIPTION_CREDENTIALS[activeSubscriptionKind].marker !== null
    : false;
  const perUserScopeReason =
    connectCopy?.perUserScopeReason ??
    `${providerConfig.name} keys are per-user — each person connects their own account, so they can only be personal.`;
  // The connected card: for provider-level subscriptions (Copilot) editing
  // implies an existing credential. For a credential-level one, editing a key
  // whose stored credential is already that subscription (known from the key
  // metadata) counts as connected too; otherwise a fresh sign-in must have set
  // it.
  const perUserCredentialConnected = isCredentialSubscriptionMode
    ? (isEditMode &&
        existingKey?.subscriptionKind === activeSubscriptionKind) ||
      (!!apiKey && apiKey !== LLM_PROVIDER_API_KEY_PLACEHOLDER)
    : hasCopilotCredential;

  const visibilityOptions = useMemo(
    (): Array<
      VisibilityOption<NonNullable<CreateLlmProviderApiKeyBody["scope"]>>
    > => [
      {
        value: "personal",
        label: scopeLabel("personal"),
        description: "Only you can use this key",
        icon: SCOPE_META.personal.icon,
      },
      {
        value: "team",
        label: scopeLabel("team"),
        description: "Available to members of one selected team",
        icon: SCOPE_META.team.icon,
        disabled: isPerUserCredential || !canReadTeams || teams.length === 0,
        disabledReason: isPerUserCredential
          ? perUserScopeReason
          : !canReadTeams
            ? "Team sharing is unavailable without team:read permission"
            : teams.length === 0
              ? "Create a team before using team scope"
              : undefined,
      },
      {
        value: "org",
        label: scopeLabel("org"),
        description: "Available to everyone in the organization",
        icon: SCOPE_META.org.icon,
        disabled: isPerUserCredential || !isLlmProviderApiKeyAdmin,
        disabledReason: isPerUserCredential
          ? perUserScopeReason
          : !isLlmProviderApiKeyAdmin
            ? "You need llmProviderApiKey:admin permission to share org-wide"
            : undefined,
      },
    ],
    [
      canReadTeams,
      isLlmProviderApiKeyAdmin,
      teams.length,
      isPerUserCredential,
      perUserScopeReason,
    ],
  );

  useEffect(() => {
    if (isEditMode) {
      return;
    }

    form.setValue("isPrimary", !hasAnyKeyForProvider);
  }, [form, hasAnyKeyForProvider, isEditMode]);

  // Default the Name field to the provider's display name so it's one less
  // field to fill, suffixed with a counter when that name is already taken by
  // a visible key of the same provider — sign-in providers (GitHub/Microsoft
  // Copilot) otherwise mint identically-named keys on every reconnect. Only
  // fill while the name is empty or still the previously auto-filled name —
  // never clobber a name the user typed.
  const autoFilledNameRef = useRef<string | null>(null);
  useEffect(() => {
    if (isEditMode) {
      return;
    }

    const currentName = form.getValues("name");
    if (currentName === "" || currentName === autoFilledNameRef.current) {
      const takenNames = new Set(
        (existingKeys ?? [])
          .filter((key) => key.provider === provider)
          .map((key) => key.name),
      );
      let defaultName = defaultKeyName;
      for (let suffix = 2; takenNames.has(defaultName); suffix++) {
        defaultName = `${defaultKeyName} (${suffix})`;
      }
      form.setValue("name", defaultName);
      autoFilledNameRef.current = defaultName;
    }
  }, [form, isEditMode, defaultKeyName, existingKeys, provider]);

  // Force personal scope when the credential is per-user (Copilot providers or
  // the OpenAI ChatGPT-subscription auth mode). For a credential-level
  // subscription the coercion waits for a credential to actually exist —
  // merely opening the subscription tab while editing a shared key must not
  // silently privatize the row (submitting in that state is blocked too; see
  // subscriptionSignInRequired).
  const perUserScopeEffective =
    isPerUserProvider ||
    (isCredentialSubscriptionMode && perUserCredentialConnected);
  useEffect(() => {
    if (perUserScopeEffective && scope !== "personal") {
      form.setValue("scope", "personal");
      form.setValue("teamId", null);
    }
  }, [form, perUserScopeEffective, scope]);

  useEffect(() => {
    if (allowedProviderSet.has(provider)) {
      return;
    }

    const firstAllowedProvider = Array.from(allowedProviderSet)[0];
    if (firstAllowedProvider) {
      form.setValue("provider", firstAllowedProvider);
    }
  }, [allowedProviderSet, form, provider]);

  useEffect(() => {
    if (scope === "team") {
      return;
    }

    form.setValue("vaultSecretPath", null);
    form.setValue("vaultSecretKey", null);
  }, [form, scope]);

  // Clear provider-specific credentials when the provider changes, so a key (or
  // base URL / AWS credential) typed for one provider can't be submitted against
  // another. Create only — the provider picker is disabled while editing. Skips
  // the initial render via the ref so it never wipes prefilled defaults.
  const prevProviderRef = useRef(provider);
  useEffect(() => {
    if (isEditMode || prevProviderRef.current === provider) return;
    const previousProvider = prevProviderRef.current;
    prevProviderRef.current = provider;
    // Switching between the two Ollama transports is not a change of provider
    // in any way that invalidates a credential: it is the same server reached
    // over a different endpoint, so the key and headers still apply. Only the
    // base URL is transport-specific (`/v1` or not), and clearing it falls back
    // to a placeholder showing the right default for the chosen transport.
    if (isOllamaProvider(previousProvider) && isOllamaProvider(provider)) {
      form.setValue("baseUrl", null);
      return;
    }
    form.setValue("apiKey", null);
    form.setValue("baseUrl", null);
    form.setValue("inferenceBaseUrl", null);
    form.setValue("extraHeaders", []);
    form.setValue("vaultSecretPath", null);
    form.setValue("vaultSecretKey", null);
    form.setValue("awsAccessKeyId", null);
    form.setValue("awsSecretAccessKey", null);
    form.setValue("awsSessionToken", null);
    // Reset the Bedrock auth method too: a stale "iam" would otherwise keep the
    // API key input hidden after switching to a non-Bedrock provider.
    form.setValue("bedrockAuthMethod", "api-key");
    // Same for the subscription auth method, so a stale "subscription" can't
    // hide the API key field after switching providers.
    form.setValue("authMethod", "api-key");
  }, [form, isEditMode, provider]);

  const vaultSecretSelector =
    scope === "team" ? (
      <InlineVaultSecretSelector
        teamId={teamId}
        selectedSecretPath={form.getValues("vaultSecretPath")}
        selectedSecretKey={form.getValues("vaultSecretKey")}
        onSecretPathChange={(value) =>
          form.setValue("vaultSecretPath", value, { shouldDirty: true })
        }
        onSecretKeyChange={(value) =>
          form.setValue("vaultSecretKey", value, { shouldDirty: true })
        }
      />
    ) : (
      <ExternalSecretSelector
        selectedTeamId={teamId}
        selectedSecretPath={form.getValues("vaultSecretPath")}
        selectedSecretKey={form.getValues("vaultSecretKey")}
        onTeamChange={(value) =>
          form.setValue("teamId", value, { shouldDirty: true })
        }
        onSecretChange={(value) =>
          form.setValue("vaultSecretPath", value, { shouldDirty: true })
        }
        onSecretKeyChange={(value) =>
          form.setValue("vaultSecretKey", value, { shouldDirty: true })
        }
      />
    );

  // Rendered either above "Advanced settings" or inside it, depending on
  // `showBaseUrlUpFront`, so the field itself is defined once.
  const baseUrlField = (
    <div className="space-y-2">
      <Label htmlFor="llm-provider-api-key-base-url">
        {isBedrock ? "Custom endpoint" : "Base URL"}{" "}
        {!isBaseUrlRequired && (
          <span className="font-normal text-muted-foreground">(optional)</span>
        )}
      </Label>
      <p className="text-xs text-muted-foreground">
        {isBedrock
          ? `Filled in from the region above. Change it only for a VPC/PrivateLink endpoint or a ${providerLabel}-compatible gateway.`
          : isVllm
            ? "The server's OpenAI-compatible API. Every model it lists is added."
            : "Override the default API endpoint. Useful for self-hosted or proxy setups."}
      </p>
      {isVllm && (
        <p className="text-xs text-muted-foreground">
          One URL per server. If you run more than one, add each as its own key
          — every model is routed to the server that hosts it.
        </p>
      )}
      {isSelfHostedProvider(provider) && (
        <p className="text-xs text-muted-foreground">
          If this app runs in Docker, <code>localhost</code> points at the
          container, not your host machine. Use{" "}
          <code>host.docker.internal</code> instead
          {dockerBaseUrlExample && (
            <>
              {" "}
              (e.g. <code>{dockerBaseUrlExample}</code>)
            </>
          )}
          .
        </p>
      )}
      <Input
        id="llm-provider-api-key-base-url"
        type="url"
        placeholder={
          (isBedrock ? bedrockRuntimeBaseUrl(bedrockRegion) : "") ||
          providerBaseUrls?.[provider] ||
          DEFAULT_PROVIDER_BASE_URLS[provider] ||
          "https://..."
        }
        disabled={isPending}
        {...form.register("baseUrl", {
          validate: (value) => {
            if (!value) {
              if (isBaseUrlRequired) {
                return "Base URL is required for this provider";
              }
              return true;
            }

            try {
              const url = new URL(value);
              if (!["http:", "https:"].includes(url.protocol)) {
                return "URL must use http or https protocol";
              }
              return true;
            } catch {
              return "Please enter a valid URL (e.g. https://api.example.com)";
            }
          },
        })}
      />
      {form.formState.errors.baseUrl && (
        <p className="text-xs text-destructive">
          {form.formState.errors.baseUrl.message}
        </p>
      )}
    </div>
  );

  return (
    <div data-testid={E2eTestId.ChatApiKeyForm}>
      <div className="space-y-4">
        {!isSubscriptionFlow && (
          <div
            className={
              mode === "full" && showProviderField
                ? "grid grid-cols-2 gap-4"
                : ""
            }
          >
            {showProviderField && (
              <div className="space-y-2">
                <Label htmlFor="llm-provider-api-key-provider">Provider</Label>
                <SearchableSelect
                  id="llm-provider-api-key-provider"
                  ariaLabel="Provider"
                  className="w-full"
                  searchPlaceholder="Search providers..."
                  emptyMessage="No matching providers found."
                  value={
                    isOllamaProvider(provider)
                      ? ollamaListedTransport
                      : provider
                  }
                  onValueChange={(value) =>
                    form.setValue(
                      "provider",
                      value as CreateLlmProviderApiKeyBody["provider"],
                    )
                  }
                  disabled={isEditMode || isPending || disableProvider}
                  items={providerOptions}
                />
              </div>
            )}

            {mode === "full" && (
              <div className="space-y-2">
                <Label htmlFor="llm-provider-api-key-name">
                  Name{" "}
                  <span className="text-muted-foreground font-normal">
                    (optional)
                  </span>
                </Label>
                <Input
                  id="llm-provider-api-key-name"
                  placeholder={defaultKeyName}
                  disabled={isPending}
                  autoComplete="off"
                  data-1p-ignore
                  data-lpignore="true"
                  {...form.register("name")}
                />
              </div>
            )}
          </div>
        )}

        {/*
          Sits outside the `byosEnabled` branch below on purpose: the transport
          is part of the provider, not a way of supplying credentials, so it
          must stay visible when keys come from the vault.
        */}
        {showOllamaTransport && (
          <div className="space-y-2">
            {/*
              A radiogroup rather than Tabs: this picks a value, it does not
              switch between panels. Radix Tabs sets `aria-controls` on every
              trigger unconditionally, so with no TabsContent both triggers
              pointed at an element id that is never rendered.
            */}
            <span
              id="llm-provider-api-key-ollama-transport"
              className="text-sm font-medium leading-none"
            >
              Transport
            </span>
            <fieldset
              className="grid w-full grid-cols-2 gap-1 rounded-lg bg-muted p-1"
              aria-labelledby="llm-provider-api-key-ollama-transport"
              disabled={isEditMode || isPending || disableProvider}
            >
              {/*
                The transport is baked into the stored provider, so an
                existing key cannot switch without being recreated.
              */}
              {OLLAMA_TRANSPORT_OPTIONS.map((option) => {
                const selected = provider === option.value;
                return (
                  <label
                    key={option.value}
                    className={cn(
                      "cursor-pointer rounded-md px-3 py-1.5 text-center text-sm font-medium transition-colors",
                      "has-disabled:cursor-not-allowed has-disabled:opacity-50",
                      selected
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <input
                      type="radio"
                      name="llm-provider-api-key-ollama-transport-option"
                      value={option.value}
                      checked={selected}
                      onChange={() => form.setValue("provider", option.value)}
                      className="sr-only"
                    />
                    {option.label}
                  </label>
                );
              })}
            </fieldset>
            <p className="text-xs text-muted-foreground">
              {provider === "ollama-native"
                ? `${providerLabel}'s own /api/chat. Supports per-model parameters such as num_ctx and thinking.`
                : `${providerLabel}'s OpenAI-compatible /v1 endpoint. Supports embeddings; per-model parameters are ignored.`}
            </p>
          </div>
        )}

        {byosEnabled && !isSubscriptionFlow ? (
          <Suspense
            fallback={
              <div className="text-sm text-muted-foreground">Loading...</div>
            }
          >
            {vaultSecretSelector}
          </Suspense>
        ) : (
          <div className="space-y-2">
            {provider === "bedrock" && (
              <Tabs
                value={bedrockAuthMethod}
                onValueChange={(value) =>
                  form.setValue(
                    "bedrockAuthMethod",
                    value as "api-key" | "sigv4" | "iam",
                    { shouldDirty: true },
                  )
                }
              >
                <TabsList className="grid w-full grid-cols-3">
                  <TabsTrigger value="api-key" disabled={isPending}>
                    API Key
                  </TabsTrigger>
                  <TabsTrigger value="sigv4" disabled={isPending}>
                    AWS SigV4
                  </TabsTrigger>
                  <TabsTrigger value="iam" disabled={isPending}>
                    Service Account
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            )}

            {provider === "bedrock" && bedrockAuthMethod === "iam" && (
              <div className="space-y-3 text-sm">
                <p className="text-muted-foreground">
                  Authenticate {providerLabel} requests using IAM credentials
                  picked up from the server's environment. Uses the AWS SDK
                  credential chain — IRSA (IAM Roles for Service Accounts),
                  EC2/ECS instance profiles, or environment variables — so no
                  static keys are stored in {appName}.
                </p>
                {bedrockIamAuthEnabled ? (
                  <div className="rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm">
                    <p className="font-medium text-green-600 dark:text-green-400">
                      Enabled on this server
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {providerLabel} requests will be signed automatically; you
                      don't need to create an API key.
                    </p>
                  </div>
                ) : (
                  <div className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
                    <p className="font-semibold text-amber-700 dark:text-amber-400">
                      Not enabled on this server
                    </p>
                    <p className="mt-2 text-foreground">
                      An admin must enable IAM auth on the backend before this
                      option can be used:
                    </p>
                    <ol className="mt-2 list-decimal space-y-1 pl-5 text-foreground">
                      <li>
                        Set the env var{" "}
                        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                          ARCHESTRA_BEDROCK_IAM_AUTH_ENABLED=true
                        </code>{" "}
                        on the {appName} backend.
                      </li>
                      <li>
                        Grant the pod's service account (IRSA) or instance
                        profile permission to call {providerLabel} (e.g.{" "}
                        <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                          bedrock:InvokeModel
                        </code>
                        ).
                      </li>
                      <li>Restart the backend to pick up the change.</li>
                    </ol>
                  </div>
                )}
              </div>
            )}

            {isCredentialLevelSubscriptionProvider(provider) &&
              providerSubscriptionKind &&
              allowPersonalSubscriptions &&
              credentialMode === undefined && (
                <Tabs
                  value={authMethod}
                  onValueChange={(value) => {
                    form.setValue(
                      "authMethod",
                      value as "api-key" | "subscription",
                      { shouldDirty: true },
                    );
                    // Clear any credential carried over from the other auth mode:
                    // a typed API key must not leak into subscription mode
                    // (false "connected" card / submit-before-sign-in), and an
                    // OAuth credential must not surface in the visible API Key
                    // field when switching back. Fires only on user interaction,
                    // so it never wipes prefilled defaults.
                    form.setValue("apiKey", null, { shouldDirty: true });
                  }}
                >
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="api-key" disabled={isPending}>
                      API Key
                    </TabsTrigger>
                    <TabsTrigger
                      value="subscription"
                      disabled={isPending || Boolean(byosEnabled)}
                    >
                      {SUBSCRIPTION_CREDENTIALS[providerSubscriptionKind].label}
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              )}

            {!isBedrockSigV4 &&
              bedrockAuthMethod !== "iam" &&
              (activeSubscriptionKind && connectCopy ? (
                <>
                  {!isSubscriptionFlow && (
                    <>
                      <Label>{connectCopy.accountLabel}</Label>
                      {connectCopy.signInHint ? (
                        <p className="text-xs text-muted-foreground">
                          {connectCopy.signInHint}
                        </p>
                      ) : (
                        providerBlurb && (
                          <p className="text-xs text-muted-foreground">
                            {providerBlurb}
                          </p>
                        )
                      )}
                    </>
                  )}
                  {subscriptionUnavailableWithByos ? (
                    <div
                      role="alert"
                      className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
                    >
                      <p className="font-medium">
                        Subscription sign-in is unavailable with Bring Your Own
                        Secrets
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {appName} has read-only access to your external Vault,
                        so it cannot save or rotate OAuth credentials there.
                        {requiresExactSubscriptionCredential
                          ? " This agent requires the same personal subscription, so a provider API key from Vault will not work. Ask an administrator to use managed secret storage, or choose a different agent or model."
                          : subscriptionHasApiKeyAlternative
                            ? " Store a provider API key in Vault instead, or ask an administrator to use managed secret storage."
                            : " This provider has no API-key alternative, so an administrator must use managed secret storage to enable subscription sign-in."}
                      </p>
                    </div>
                  ) : (
                    <>
                      {perUserCredentialConnected && (
                        <div className="flex items-start gap-2 rounded-md border border-green-500/40 bg-green-500/10 p-3 text-sm">
                          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-green-500" />
                          <div>
                            <p className="font-medium text-green-600 dark:text-green-400">
                              {connectCopy.connectedTitle}
                            </p>
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {connectCopy.connectedDescription}
                              {isEditMode && !isCredentialSubscriptionMode ? (
                                <span>
                                  {" Sign in again below to refresh the token."}
                                </span>
                              ) : null}
                            </p>
                          </div>
                        </div>
                      )}
                      <SubscriptionSignIn
                        kind={activeSubscriptionKind}
                        disabled={isPending}
                        onSecret={async (secret) => {
                          if (onSubscriptionCredential) {
                            await onSubscriptionCredential(secret);
                            return;
                          }
                          form.setValue("apiKey", secret, {
                            shouldDirty: true,
                          });
                        }}
                      />
                    </>
                  )}
                </>
              ) : (
                <>
                  <Label htmlFor="llm-provider-api-key-value">
                    API Key{" "}
                    {isProviderApiKeyOptional({
                      provider,
                      azureEntraIdEnabled: azureOpenAiEntraIdEnabled === true,
                      anthropicWifEnabled: anthropicWifEnabled === true,
                    }) ? (
                      <span className="font-normal text-muted-foreground">
                        (optional)
                      </span>
                    ) : (
                      isEditMode && (
                        <span className="font-normal text-muted-foreground">
                          (leave blank to keep current)
                        </span>
                      )
                    )}
                  </Label>
                  {providerBlurb && (
                    <p className="text-xs text-muted-foreground">
                      {providerBlurb}
                    </p>
                  )}
                  <div className="relative">
                    <SecretInput
                      id="llm-provider-api-key-value"
                      placeholder={providerConfig.placeholder}
                      disabled={isPending}
                      // Offer the reveal toggle when adding a key so the user
                      // can verify what they typed or pasted. Editing keeps the
                      // "configured" check in that same corner instead, and
                      // gating on the (constant) edit mode avoids remounting the
                      // input mid-edit when the check would otherwise toggle.
                      revealable={!isEditMode}
                      className={
                        showConfiguredStyling ? "border-green-500 pr-10" : ""
                      }
                      {...form.register("apiKey")}
                    />
                    {showConfiguredStyling && (
                      <CheckCircle2 className="absolute right-3 top-1/2 h-5 w-5 -translate-y-1/2 text-green-500" />
                    )}
                  </div>
                  {showConsoleLink && (
                    <p className="text-xs text-muted-foreground">
                      Get your API key from{" "}
                      <Link
                        href={providerConfig.consoleUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline hover:text-foreground"
                      >
                        {providerConfig.consoleName}
                      </Link>
                    </p>
                  )}
                </>
              ))}

            {isBedrockSigV4 && (
              <div className="space-y-3">
                <div className="space-y-2">
                  <Label htmlFor="llm-provider-aws-access-key-id">
                    Access Key ID
                  </Label>
                  <SecretInput
                    id="llm-provider-aws-access-key-id"
                    placeholder="AKIA..."
                    disabled={isPending}
                    {...form.register("awsAccessKeyId")}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="llm-provider-aws-secret-access-key">
                    Secret Access Key
                  </Label>
                  <SecretInput
                    id="llm-provider-aws-secret-access-key"
                    placeholder="••••••••"
                    disabled={isPending}
                    {...form.register("awsSecretAccessKey")}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="llm-provider-aws-session-token">
                    Session Token{" "}
                    <span className="font-normal text-muted-foreground">
                      (optional)
                    </span>
                  </Label>
                  <SecretInput
                    id="llm-provider-aws-session-token"
                    placeholder="Required for temporary credentials (STS / AssumeRole)"
                    disabled={isPending}
                    {...form.register("awsSessionToken")}
                  />
                </div>
                {showConsoleLink && (
                  <p className="text-xs text-muted-foreground">
                    Manage IAM credentials in the{" "}
                    <Link
                      href="https://console.aws.amazon.com/iam/home#/users"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline hover:text-foreground"
                    >
                      AWS IAM Console
                    </Link>
                    .
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {!hideScopeAndPrimary && !isSubscriptionFlow && (
          <VisibilitySelector
            label="Scope"
            value={scope}
            options={visibilityOptions}
            onValueChange={(nextScope) => {
              form.setValue("scope", nextScope, { shouldDirty: true });
              if (nextScope !== "team") {
                form.setValue("teamId", null, { shouldDirty: true });
              }
            }}
          >
            {scope === "team" && (
              <div className="space-y-2">
                <Label htmlFor="llm-provider-api-key-team">Team</Label>
                <Select
                  value={teamId ?? undefined}
                  onValueChange={(value) =>
                    form.setValue("teamId", value, { shouldDirty: true })
                  }
                  disabled={isPending || !canReadTeams || teams.length === 0}
                >
                  <SelectTrigger
                    id="llm-provider-api-key-team"
                    className="w-full"
                  >
                    <SelectValue placeholder="Select a team" />
                  </SelectTrigger>
                  <SelectContent>
                    {teams.map((team) => (
                      <SelectItem key={team.id} value={team.id}>
                        {team.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </VisibilitySelector>
        )}

        {/* Region is a primary Bedrock field, not an advanced one: AWS enables
            models per region, so a key is unusable until it points at the right
            one. The endpoint it writes lives under Advanced settings below. */}
        {!isSubscriptionFlow && isBedrock && (
          <div className="space-y-2">
            <Label htmlFor="llm-provider-api-key-bedrock-region">Region</Label>
            <p className="text-xs text-muted-foreground">
              The AWS region to send {providerLabel} requests to. Models are
              enabled per region, so pick the one where your models are
              available.
            </p>
            <Select
              value={bedrockRegion}
              onValueChange={(region) =>
                form.setValue("baseUrl", bedrockRuntimeBaseUrl(region), {
                  shouldDirty: true,
                })
              }
              disabled={isPending}
            >
              <SelectTrigger id="llm-provider-api-key-bedrock-region">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BEDROCK_REGIONS.map(({ id, label }) => (
                  <SelectItem key={id} value={id}>
                    {label} — {id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {hasUnresolvedBedrockRegion && (
              <p className="text-xs text-amber-600 dark:text-amber-500">
                The custom endpoint in Advanced settings carries no recognizable
                region, so requests will run against{" "}
                <code>{DEFAULT_BEDROCK_REGION}</code>. Use a{" "}
                <code>bedrock-runtime.&lt;region&gt;.amazonaws.com</code>{" "}
                endpoint to pin a different one.
              </p>
            )}
          </div>
        )}

        {!isSubscriptionFlow && showBaseUrlUpFront && baseUrlField}

        {progressive && !isSubscriptionFlow && (
          <Button
            type="button"
            variant="ghost"
            className="h-auto w-full justify-between px-0 py-2 text-sm"
            aria-expanded={advancedSettingsOpen}
            onClick={() => setAdvancedSettingsOpen((open) => !open)}
          >
            Advanced settings
            <ChevronDown
              className={`size-4 transition-transform ${advancedSettingsOpen ? "rotate-180" : ""}`}
            />
          </Button>
        )}

        {showAdvancedSettings &&
          !isSubscriptionFlow &&
          !hideScopeAndPrimary && (
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="llm-provider-api-key-is-primary">
                  Primary key
                </Label>
                <p className="text-xs text-muted-foreground">
                  <span>
                    {existingPrimaryKey
                      ? `"${existingPrimaryKey.name}" is already the primary key for this provider and scope.`
                      : "When multiple keys exist for the same provider and scope, the primary key is preferred."}
                  </span>{" "}
                  {/* The mechanism, which the sentence above only implies: key
                      resolution takes the conversation's pinned key, then the
                      agent's configured one, and only then falls through a
                      scope's keys — primary first, oldest after. */}
                  <span>
                    Chats and agents without a key of their own fall back to it;
                    with no primary set, the oldest key is used.
                  </span>
                </p>
              </div>
              <Switch
                id="llm-provider-api-key-is-primary"
                checked={form.watch("isPrimary")}
                onCheckedChange={(checked) =>
                  form.setValue("isPrimary", checked, { shouldDirty: true })
                }
                disabled={isPending || Boolean(existingPrimaryKey)}
              />
            </div>
          )}

        {!isSubscriptionFlow &&
          !showBaseUrlUpFront &&
          showAdvancedSettings &&
          baseUrlField}

        {!isSubscriptionFlow &&
          showAdvancedSettings &&
          provider === "azure" && (
            <div className="space-y-2">
              <Label htmlFor="llm-provider-api-key-inference-base-url">
                Inference URL{" "}
                <span className="font-normal text-muted-foreground">
                  (optional)
                </span>
              </Label>
              <p className="text-xs text-muted-foreground">
                Runtime endpoint for chat and embeddings when it differs from
                the Base URL used for Azure deployment discovery.
              </p>
              <Input
                id="llm-provider-api-key-inference-base-url"
                type="url"
                placeholder="https://<resource>.openai.azure.com/openai"
                disabled={isPending}
                {...form.register("inferenceBaseUrl", {
                  validate: (value) => {
                    if (!value) return true;

                    try {
                      const url = new URL(value);
                      if (!["http:", "https:"].includes(url.protocol)) {
                        return "URL must use http or https protocol";
                      }
                      return true;
                    } catch {
                      return "Please enter a valid URL (e.g. https://api.example.com)";
                    }
                  },
                })}
              />
              {form.formState.errors.inferenceBaseUrl && (
                <p className="text-xs text-destructive">
                  {form.formState.errors.inferenceBaseUrl.message}
                </p>
              )}
            </div>
          )}

        {!isSubscriptionFlow && showAdvancedSettings && (
          <div className="space-y-2">
            <Label>
              Extra HTTP headers{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
            </Label>
            <p className="text-xs text-muted-foreground">
              Sent on every request to the provider. Useful for gateways that
              require custom RBAC headers (e.g. <code>kubeflow-userid</code>).
            </p>
            {extraHeadersFieldArray.fields.length > 0 && (
              <div className="space-y-2">
                {extraHeadersFieldArray.fields.map((field, index) => (
                  <div key={field.id} className="flex items-start gap-2">
                    <Input
                      aria-label="Header name"
                      placeholder="Header name"
                      disabled={isPending}
                      className="flex-1"
                      {...form.register(`extraHeaders.${index}.name` as const)}
                    />
                    <Input
                      aria-label="Header value"
                      placeholder="Header value"
                      disabled={isPending}
                      className="flex-1"
                      {...form.register(`extraHeaders.${index}.value` as const)}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      disabled={isPending}
                      onClick={() => extraHeadersFieldArray.remove(index)}
                      aria-label={`Remove header ${index + 1}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isPending}
              onClick={() =>
                extraHeadersFieldArray.append({ name: "", value: "" })
              }
            >
              Add header
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
