"use client";

import {
  type archestraApiTypes,
  DEFAULT_PROVIDER_BASE_URLS,
  E2eTestId,
  PROVIDERS_WITH_OPTIONAL_API_KEY,
} from "@shared";
import { Building2, CheckCircle2, User, Users } from "lucide-react";
import Link from "next/link";
import { lazy, Suspense, useEffect, useMemo } from "react";
import type { UseFormReturn } from "react-hook-form";
import { ExternalDocsLink } from "@/components/external-docs-link";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature, useProviderBaseUrls } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useTeams } from "@/lib/teams/team.query";
import { LlmProviderSelectItems } from "./llm-provider-options";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Switch } from "./ui/switch";

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
  scope: NonNullable<CreateLlmProviderApiKeyBody["scope"]>;
  teamId: string | null;
  vaultSecretPath: string | null;
  vaultSecretKey: string | null;
  isPrimary: boolean;
};

export type LlmProviderApiKeyResponse =
  archestraApiTypes.GetLlmProviderApiKeysResponses["200"][number];

const PROVIDER_CONFIG: Record<
  CreateLlmProviderApiKeyBody["provider"],
  {
    name: string;
    icon: string;
    placeholder: string;
    enabled: boolean;
    consoleUrl: string;
    consoleName: string;
    description?: string;
    baseUrlRequired?: boolean;
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
    name: "vLLM",
    icon: "/icons/vllm.png",
    placeholder: "optional-api-key",
    enabled: true,
    consoleUrl: "https://docs.vllm.ai/",
    consoleName: "vLLM Docs",
  },
  ollama: {
    name: "Ollama",
    icon: "/icons/ollama.png",
    placeholder: "optional-api-key",
    enabled: true,
    consoleUrl: "https://ollama.ai/",
    consoleName: "Ollama",
    description: "For self-hosted Ollama, an API key is not required.",
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
  bedrock: {
    name: "AWS Bedrock",
    icon: "/icons/bedrock.png",
    placeholder: "Bedrock API key (bedrock-api-key-... / ABSK...)",
    enabled: true,
    consoleUrl: "https://console.aws.amazon.com/bedrock",
    consoleName: "AWS Console",
    baseUrlRequired: true,
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
      "Set Base URL to: https://<resource>.openai.azure.com/openai/deployments/<deployment>",
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
}: LlmProviderApiKeyFormProps) {
  const authDocsUrl = getFrontendDocsUrl("platform-llm-proxy-authentication");
  const byosEnabled = useFeature("byosEnabled");
  const { data: providerBaseUrls } = useProviderBaseUrls();
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: isLlmProviderApiKeyAdmin } = useHasPermissions({
    llmProviderApiKey: ["admin"],
  });
  const { data: teams = [] } = useTeams();
  const isEditMode = Boolean(existingKey);

  const provider = form.watch("provider");
  const apiKey = form.watch("apiKey");
  const scope = form.watch("scope");
  const teamId = form.watch("teamId");

  const hasApiKeyChanged =
    apiKey !== LLM_PROVIDER_API_KEY_PLACEHOLDER && apiKey !== "";
  const providerConfig = PROVIDER_CONFIG[provider];
  const isBaseUrlRequired =
    providerConfig.baseUrlRequired && !providerBaseUrls?.[provider];

  const allowedProviderSet = useMemo(
    () =>
      new Set<CreateLlmProviderApiKeyBody["provider"]>(
        allowedProviders ??
          (Object.keys(
            PROVIDER_CONFIG,
          ) as CreateLlmProviderApiKeyBody["provider"][]),
      ),
    [allowedProviders],
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

  const visibilityOptions = useMemo(
    (): Array<
      VisibilityOption<NonNullable<CreateLlmProviderApiKeyBody["scope"]>>
    > => [
      {
        value: "personal",
        label: "Personal",
        description: "Only you can use this key",
        icon: User,
      },
      {
        value: "team",
        label: "Team",
        description: "Available to members of one selected team",
        icon: Users,
        disabled: !canReadTeams || teams.length === 0,
        disabledReason: !canReadTeams
          ? "Team sharing is unavailable without team:read permission"
          : teams.length === 0
            ? "Create a team before using team scope"
            : undefined,
      },
      {
        value: "org",
        label: "Organization",
        description: "Available to everyone in the organization",
        icon: Building2,
        disabled: !isLlmProviderApiKeyAdmin,
        disabledReason: !isLlmProviderApiKeyAdmin
          ? "You need llmProviderApiKey:admin permission to share org-wide"
          : undefined,
      },
    ],
    [canReadTeams, isLlmProviderApiKeyAdmin, teams.length],
  );

  useEffect(() => {
    if (isEditMode) {
      return;
    }

    form.setValue("isPrimary", !hasAnyKeyForProvider);
  }, [form, hasAnyKeyForProvider, isEditMode]);

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

  const vaultSecretSelector =
    scope === "team" ? (
      <InlineVaultSecretSelector
        teamId={teamId}
        selectedSecretPath={form.getValues("vaultSecretPath")}
        selectedSecretKey={form.getValues("vaultSecretKey")}
        onSecretPathChange={(value) => form.setValue("vaultSecretPath", value)}
        onSecretKeyChange={(value) => form.setValue("vaultSecretKey", value)}
      />
    ) : (
      <ExternalSecretSelector
        selectedTeamId={teamId}
        selectedSecretPath={form.getValues("vaultSecretPath")}
        selectedSecretKey={form.getValues("vaultSecretKey")}
        onTeamChange={(value) => form.setValue("teamId", value)}
        onSecretChange={(value) => form.setValue("vaultSecretPath", value)}
        onSecretKeyChange={(value) => form.setValue("vaultSecretKey", value)}
      />
    );

  return (
    <div data-testid={E2eTestId.ChatApiKeyForm}>
      <div className="space-y-4">
        <div className={mode === "full" ? "grid grid-cols-2 gap-4" : ""}>
          <div className="space-y-2">
            <Label htmlFor="llm-provider-api-key-provider">Provider</Label>
            <Select
              value={provider}
              onValueChange={(value) =>
                form.setValue(
                  "provider",
                  value as CreateLlmProviderApiKeyBody["provider"],
                )
              }
              disabled={isEditMode || isPending || disableProvider}
            >
              <SelectTrigger
                id="llm-provider-api-key-provider"
                className="w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <LlmProviderSelectItems
                  options={Object.entries(PROVIDER_CONFIG)
                    .sort(([, a], [, b]) => a.name.localeCompare(b.name))
                    .map(([key, config]) => {
                      const providerKey =
                        key as CreateLlmProviderApiKeyBody["provider"];
                      const isGeminiDisabledByVertexAi =
                        providerKey === "gemini" && geminiVertexAiEnabled;
                      const isBedrockDisabledByIamAuth =
                        providerKey === "bedrock" && bedrockIamAuthEnabled;

                      return {
                        value: providerKey,
                        icon: config.icon,
                        name: config.name,
                        disabled:
                          !allowedProviderSet.has(providerKey) ||
                          !config.enabled ||
                          isGeminiDisabledByVertexAi ||
                          isBedrockDisabledByIamAuth,
                        showComingSoon: !config.enabled,
                        showGeminiVertexAiBadge: isGeminiDisabledByVertexAi,
                        showBedrockIamBadge: isBedrockDisabledByIamAuth,
                      };
                    })}
                />
              </SelectContent>
            </Select>
          </div>

          {mode === "full" && (
            <div className="space-y-2">
              <Label htmlFor="llm-provider-api-key-name">Name</Label>
              <Input
                id="llm-provider-api-key-name"
                placeholder={`My ${providerConfig.name} Key`}
                disabled={isPending}
                {...form.register("name")}
              />
            </div>
          )}
        </div>

        {byosEnabled ? (
          <Suspense
            fallback={
              <div className="text-sm text-muted-foreground">Loading...</div>
            }
          >
            {vaultSecretSelector}
          </Suspense>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="llm-provider-api-key-value">
              API Key{" "}
              {PROVIDERS_WITH_OPTIONAL_API_KEY.has(provider) ? (
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
            {providerConfig.description && (
              <p className="text-xs text-muted-foreground">
                {providerConfig.description}
              </p>
            )}
            <div className="relative">
              <Input
                id="llm-provider-api-key-value"
                type="password"
                placeholder={providerConfig.placeholder}
                disabled={isPending}
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
          </div>
        )}

        {!hideScopeAndPrimary && (
          <>
            <VisibilitySelector
              label="Scope"
              value={scope}
              options={visibilityOptions}
              onValueChange={(nextScope) => {
                form.setValue("scope", nextScope);
                if (nextScope !== "team") {
                  form.setValue("teamId", null);
                }
              }}
            >
              <p className="text-xs text-muted-foreground">
                Controls who can use this key.
                {authDocsUrl && (
                  <>
                    {" "}
                    <ExternalDocsLink
                      href={`${authDocsUrl}#api-key-scoping`}
                      className="text-inherit underline hover:text-foreground"
                      showIcon={false}
                    >
                      Learn more
                    </ExternalDocsLink>
                  </>
                )}
              </p>

              {scope === "team" && (
                <div className="space-y-2">
                  <Label htmlFor="llm-provider-api-key-team">Team</Label>
                  <Select
                    value={teamId ?? undefined}
                    onValueChange={(value) => form.setValue("teamId", value)}
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

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="llm-provider-api-key-is-primary">
                  Primary key
                </Label>
                <p className="text-xs text-muted-foreground">
                  {existingPrimaryKey
                    ? `"${existingPrimaryKey.name}" is already the primary key for this provider and scope`
                    : "When multiple keys exist for the same provider and scope, the primary key is preferred"}
                </p>
              </div>
              <Switch
                id="llm-provider-api-key-is-primary"
                checked={form.watch("isPrimary")}
                onCheckedChange={(checked) =>
                  form.setValue("isPrimary", checked)
                }
                disabled={isPending || Boolean(existingPrimaryKey)}
              />
            </div>
          </>
        )}

        <div className="space-y-2">
          <Label htmlFor="llm-provider-api-key-base-url">
            Base URL{" "}
            {!isBaseUrlRequired && (
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            Override the default API endpoint. Useful for self-hosted or proxy
            setups.
          </p>
          <Input
            id="llm-provider-api-key-base-url"
            type="url"
            placeholder={
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
      </div>
    </div>
  );
}
