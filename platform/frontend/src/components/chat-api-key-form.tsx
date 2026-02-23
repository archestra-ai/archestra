"use client";

import {
  type archestraApiTypes,
  DEFAULT_PROVIDER_BASE_URLS,
  E2eTestId,
  PROVIDERS_WITH_OPTIONAL_API_KEY,
} from "@shared";
import { Building2, CheckCircle2, User, Users } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { lazy, Suspense, useEffect, useMemo } from "react";
import type { UseFormReturn } from "react-hook-form";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useProviderBaseUrls } from "@/lib/config.query";
import { useFeatureFlag } from "@/lib/features.hook";
import { useTeams } from "@/lib/team.query";
import { WithPermissions } from "./roles/with-permissions";

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

type CreateChatApiKeyBody = archestraApiTypes.CreateChatApiKeyData["body"];

// Form values type - combines create/update fields
export type ChatApiKeyFormValues = {
  name: string;
  provider: CreateChatApiKeyBody["provider"];
  apiKey: string | null;
  baseUrl: string | null;
  scope: NonNullable<CreateChatApiKeyBody["scope"]>;
  teamId: string | null;
  vaultSecretPath: string | null;
  vaultSecretKey: string | null;
  /** When multiple keys exist for the same provider+scope, the primary key is preferred */
  isPrimary: boolean;
};

// Response type for existing keys
export type ChatApiKeyResponse =
  archestraApiTypes.GetChatApiKeysResponses["200"][number];

const PROVIDER_CONFIG: Record<
  CreateChatApiKeyBody["provider"],
  {
    name: string;
    icon: string;
    placeholder: string;
    enabled: boolean;
    consoleUrl: string;
    consoleName: string;
    description?: string;
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
    placeholder: "Bearer token...",
    enabled: true,
    consoleUrl: "https://console.aws.amazon.com/bedrock",
    consoleName: "AWS Console",
  },
} as const;

export { PROVIDER_CONFIG };

export const PLACEHOLDER_KEY = "••••••••••••••••";

interface ChatApiKeyFormProps {
  /**
   * Form mode:
   * - "full": Shows all fields including name (for settings page dialog)
   * - "compact": Hides name field, auto-generates name (for onboarding)
   */
  mode?: "full" | "compact";
  /**
   * Whether to show the console link for getting API keys
   */
  showConsoleLink?: boolean;
  /**
   * Existing key to edit. When provided, form is in "edit" mode.
   * Provider is disabled, but scope and team can be changed.
   */
  existingKey?: ChatApiKeyResponse;
  /**
   * All existing API keys visible to the user.
   * Used to determine isPrimary default and show existing primary key info.
   */
  existingKeys?: ChatApiKeyResponse[];
  /**
   * Form object from parent (created with useForm)
   */
  form: UseFormReturn<ChatApiKeyFormValues>;
  /**
   * Whether mutation is pending (from parent)
   */
  isPending?: boolean;
  /**
   * Whether Gemini Vertex AI mode is enabled.
   * When true, Gemini provider is disabled (uses ADC instead of API key).
   */
  geminiVertexAiEnabled?: boolean;
}

/**
 * Form for creating/updating Chat API keys.
 * Form state is managed by parent via react-hook-form.
 * Parent handles mutations and submission.
 */
export function ChatApiKeyForm({
  mode = "full",
  showConsoleLink = true,
  existingKey,
  existingKeys,
  form,
  isPending = false,
  geminiVertexAiEnabled = false,
}: ChatApiKeyFormProps) {
  const byosEnabled = useFeatureFlag("byosEnabled");
  const { data: providerBaseUrls } = useProviderBaseUrls();
  const isEditMode = Boolean(existingKey);

  // Data fetching for team selector
  const { data: teams = [] } = useTeams();

  // Watch form values
  const provider = form.watch("provider");
  const apiKey = form.watch("apiKey");
  const scope = form.watch("scope");
  const teamId = form.watch("teamId");

  // Check if API key has been changed from placeholder
  const hasApiKeyChanged = apiKey !== PLACEHOLDER_KEY && apiKey !== "";

  const providerConfig = PROVIDER_CONFIG[provider];

  // Determine if we should show the "configured" styling
  const showConfiguredStyling = isEditMode && !hasApiKeyChanged;

  // Disable team scope if no teams exist
  const isTeamScopeDisabled = teams.length === 0;

  // Find existing primary key for the current provider+scope combination
  const existingPrimaryKey = useMemo(() => {
    if (!existingKeys) return null;
    // In edit mode, exclude the current key
    const otherKeys = existingKey
      ? existingKeys.filter((k) => k.id !== existingKey.id)
      : existingKeys;
    return (
      otherKeys.find(
        (k) =>
          k.provider === provider &&
          k.scope === scope &&
          (scope !== "team" || k.teamId === teamId) &&
          k.isPrimary,
      ) ?? null
    );
  }, [existingKeys, existingKey, provider, scope, teamId]);

  // Auto-set isPrimary when no user-created keys exist for this provider+scope (create mode only).
  // System keys are auto-managed and shouldn't prevent the user from marking their key as primary.
  const hasAnyKeyForProvider = useMemo(() => {
    if (!existingKeys) return false;
    return existingKeys.some(
      (k) =>
        k.provider === provider &&
        k.scope === scope &&
        (scope !== "team" || k.teamId === teamId) &&
        !k.isSystem,
    );
  }, [existingKeys, provider, scope, teamId]);

  useEffect(() => {
    if (isEditMode) return;
    form.setValue("isPrimary", !hasAnyKeyForProvider);
  }, [hasAnyKeyForProvider, isEditMode, form]);

  // Clean vault secret values when changing scope
  useEffect(() => {
    if (scope !== "team") {
      form.setValue("vaultSecretPath", null);
      form.setValue("vaultSecretKey", null);
    }
  }, [scope, form]);

  const vaultSecretSelector =
    scope === "team" ? (
      <InlineVaultSecretSelector
        teamId={teamId}
        selectedSecretPath={form.getValues("vaultSecretPath")}
        selectedSecretKey={form.getValues("vaultSecretKey")}
        onSecretPathChange={(v) => form.setValue("vaultSecretPath", v)}
        onSecretKeyChange={(v) => form.setValue("vaultSecretKey", v)}
      />
    ) : (
      <ExternalSecretSelector
        selectedTeamId={teamId}
        selectedSecretPath={form.getValues("vaultSecretPath")}
        selectedSecretKey={form.getValues("vaultSecretKey")}
        onTeamChange={(v) => form.setValue("teamId", v)}
        onSecretChange={(v) => form.setValue("vaultSecretPath", v)}
        onSecretKeyChange={(v) => form.setValue("vaultSecretKey", v)}
      />
    );

  return (
    <div data-testid={E2eTestId.ChatApiKeyForm}>
      <div className="space-y-4">
        {/* Provider + Name (same row in full mode) */}
        <div className={mode === "full" ? "grid grid-cols-2 gap-4" : ""}>
          <div className="space-y-2">
            <Label htmlFor="chat-api-key-provider">Provider</Label>
            <Select
              value={provider}
              onValueChange={(v) =>
                form.setValue("provider", v as CreateChatApiKeyBody["provider"])
              }
              disabled={isEditMode || isPending}
            >
              <SelectTrigger id="chat-api-key-provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(PROVIDER_CONFIG)
                  .sort(([, a], [, b]) => a.name.localeCompare(b.name))
                  .map(([key, config]) => {
                    const isGeminiDisabledByVertexAi =
                      key === "gemini" && geminiVertexAiEnabled;
                    const isDisabled =
                      !config.enabled || isGeminiDisabledByVertexAi;

                    return (
                      <SelectItem key={key} value={key} disabled={isDisabled}>
                        <div className="flex items-center gap-2">
                          <Image
                            src={config.icon}
                            alt={config.name}
                            width={16}
                            height={16}
                            className="rounded dark:invert"
                          />
                          <span>{config.name}</span>
                          {!config.enabled && (
                            <Badge variant="outline" className="ml-2 text-xs">
                              Coming Soon
                            </Badge>
                          )}
                          {isGeminiDisabledByVertexAi && (
                            <Badge variant="secondary" className="ml-2 text-xs">
                              Vertex AI
                            </Badge>
                          )}
                        </div>
                      </SelectItem>
                    );
                  })}
              </SelectContent>
            </Select>
          </div>

          {mode === "full" && (
            <div className="space-y-2">
              <Label htmlFor="chat-api-key-name">Name</Label>
              <Input
                id="chat-api-key-name"
                placeholder={`My ${providerConfig.name} Key`}
                disabled={isPending}
                {...form.register("name")}
              />
            </div>
          )}
        </div>

        {/* API Key input */}
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
            <Label htmlFor="chat-api-key-value">
              API Key{" "}
              {PROVIDERS_WITH_OPTIONAL_API_KEY.has(provider) ? (
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              ) : (
                isEditMode && (
                  <span className="text-muted-foreground font-normal">
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
                id="chat-api-key-value"
                type="password"
                placeholder={providerConfig.placeholder}
                disabled={isPending}
                className={
                  showConfiguredStyling ? "border-green-500 pr-10" : ""
                }
                {...form.register("apiKey")}
              />
              {showConfiguredStyling && (
                <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-green-500" />
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

        {/* Visibility/Scope selector */}
        <div className="space-y-2">
          <Label htmlFor="chat-api-key-scope">Scope</Label>
          <p className="text-xs text-muted-foreground">
            Controls who can use this key.{" "}
            <Link
              href="https://archestra.ai/docs/platform-llm-proxy-authentication#api-key-scoping"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              Learn more
            </Link>
          </p>
          <Select
            value={scope}
            onValueChange={(v) => {
              form.setValue(
                "scope",
                v as NonNullable<CreateChatApiKeyBody["scope"]>,
              );
              if (v !== "team") {
                form.setValue("teamId", "");
              }
            }}
            disabled={isPending}
          >
            <SelectTrigger id="chat-api-key-scope" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="personal">
                <div className="flex items-center gap-2">
                  <User className="h-4 w-4" />
                  <span>Personal</span>
                </div>
              </SelectItem>
              <SelectItem value="team" disabled={isTeamScopeDisabled}>
                <div className="flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  <span>Team</span>
                  {isTeamScopeDisabled && (
                    <span className="text-xs text-muted-foreground">
                      (no teams available)
                    </span>
                  )}
                </div>
              </SelectItem>
              <WithPermissions
                permissions={{ team: ["admin"] }}
                noPermissionHandle="hide"
              >
                <SelectItem value="org_wide">
                  <div className="flex items-center gap-2">
                    <Building2 className="h-4 w-4" />
                    <span>Organization</span>
                  </div>
                </SelectItem>
              </WithPermissions>
            </SelectContent>
          </Select>
        </div>

        {/* Team selector - only when scope is team */}
        {scope === "team" && (
          <div className="space-y-2">
            <Label htmlFor="chat-api-key-team">Team</Label>
            <Select
              value={teamId ?? undefined}
              onValueChange={(v) => form.setValue("teamId", v)}
              disabled={isPending}
            >
              <SelectTrigger id="chat-api-key-team" className="w-full">
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

        {/* Primary key toggle */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="chat-api-key-is-primary">Primary key</Label>
            <p className="text-xs text-muted-foreground">
              {existingPrimaryKey
                ? `"${existingPrimaryKey.name}" is already the primary key for this provider and scope`
                : "When multiple keys exist for the same provider and scope, the primary key is preferred"}
            </p>
          </div>
          <Switch
            id="chat-api-key-is-primary"
            checked={form.watch("isPrimary")}
            onCheckedChange={(checked) => form.setValue("isPrimary", checked)}
            disabled={isPending || !!existingPrimaryKey}
          />
        </div>

        {/* Base URL input */}
        <div className="space-y-2">
          <Label htmlFor="chat-api-key-base-url">
            Base URL{" "}
            <span className="text-muted-foreground font-normal">
              (optional)
            </span>
          </Label>
          <p className="text-xs text-muted-foreground">
            Override the default API endpoint. Useful for self-hosted or proxy
            setups.
          </p>
          <Input
            id="chat-api-key-base-url"
            type="url"
            placeholder={
              providerBaseUrls?.[provider] ||
              DEFAULT_PROVIDER_BASE_URLS[provider] ||
              "https://..."
            }
            disabled={isPending}
            {...form.register("baseUrl", {
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
