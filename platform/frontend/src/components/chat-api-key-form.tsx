"use client";

import { type archestraApiTypes, E2eTestId } from "@shared";
import { Building2, CheckCircle2, User, Users } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { lazy, Suspense, useEffect, useMemo, useRef } from "react";
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
  scope: NonNullable<CreateChatApiKeyBody["scope"]>;
  teamId: string | null;
  vaultSecretPath: string | null;
  vaultSecretKey: string | null;
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
   * Provider is disabled, but scope and team can be changed (with uniqueness constraints).
   */
  existingKey?: ChatApiKeyResponse;
  /**
   * All existing API keys visible to the user.
   * Used to disable scope/team options that would violate uniqueness constraints.
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

  // Compute which scopes are disabled based on existing keys for this provider
  const disabledScopes = useMemo(() => {
    if (!existingKeys) {
      return { personal: false, team: false, org_wide: false };
    }

    // In edit mode, exclude the current key from the check (so it doesn't block itself)
    const otherKeys = existingKey
      ? existingKeys.filter((k) => k.id !== existingKey.id)
      : existingKeys;

    const keysForProvider = otherKeys.filter((k) => k.provider === provider);

    return {
      // Personal: disabled if user already has one for this provider
      personal: keysForProvider.some((k) => k.scope === "personal"),
      // Org-wide: disabled if org already has one for this provider
      org_wide: keysForProvider.some((k) => k.scope === "org_wide"),
      // Team: we'll handle individual teams separately
      team: false,
    };
  }, [existingKeys, provider, existingKey]);

  // Teams already used for this provider
  const usedTeamIds = useMemo(() => {
    if (!existingKeys) return new Set<string>();

    // In edit mode, exclude the current key from the check (so it doesn't block itself)
    const otherKeys = existingKey
      ? existingKeys.filter((k) => k.id !== existingKey.id)
      : existingKeys;

    return new Set(
      otherKeys
        .filter(
          (k) => k.provider === provider && k.scope === "team" && k.teamId,
        )
        .map((k) => k.teamId as string),
    );
  }, [existingKeys, provider, existingKey]);

  // Available teams (filter out already-used ones)
  const availableTeams = useMemo(() => {
    return teams.filter((t) => !usedTeamIds.has(t.id));
  }, [teams, usedTeamIds]);

  // Disable team scope if no teams are available
  const isTeamScopeDisabled = availableTeams.length === 0;

  // Track previous provider to detect changes
  const prevProviderRef = useRef(provider);

  // Auto-select first available scope when provider changes and current scope is disabled
  useEffect(() => {
    if (isEditMode) return;

    const providerChanged = prevProviderRef.current !== provider;
    prevProviderRef.current = provider;

    const currentScopeDisabled =
      (scope === "personal" && disabledScopes.personal) ||
      (scope === "org_wide" && disabledScopes.org_wide) ||
      (scope === "team" && isTeamScopeDisabled);

    // Re-evaluate scope selection when provider changes or current scope becomes disabled
    if (providerChanged || currentScopeDisabled) {
      // Find first non-disabled scope
      if (!disabledScopes.personal) {
        form.setValue("scope", "personal");
      } else if (!isTeamScopeDisabled) {
        form.setValue("scope", "team");
      } else if (!disabledScopes.org_wide) {
        form.setValue("scope", "org_wide");
      }
    }
  }, [provider, disabledScopes, isTeamScopeDisabled, scope, form, isEditMode]);

  // Clear teamId when switching to team scope if current selection is invalid
  useEffect(() => {
    if (scope === "team" && teamId && usedTeamIds.has(teamId)) {
      form.setValue("teamId", "");
    }
  }, [scope, teamId, usedTeamIds, form]);

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
        {/* Name field - only in full mode */}
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
        {/* Provider selector */}
        <div className="space-y-2">
          <Label htmlFor="chat-api-key-provider">Provider</Label>
          <Select
            value={provider}
            onValueChange={(v) =>
              form.setValue("provider", v as CreateChatApiKeyBody["provider"])
            }
            disabled={isEditMode || isPending}
          >
            <SelectTrigger id="chat-api-key-provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(PROVIDER_CONFIG).map(([key, config]) => {
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

        {/* Visibility/Scope selector */}
        <div className="space-y-2">
          <Label htmlFor="chat-api-key-scope">Scope</Label>
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
            <SelectTrigger id="chat-api-key-scope">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="personal" disabled={disabledScopes.personal}>
                <div className="flex items-center gap-2">
                  <User className="h-4 w-4" />
                  <span>
                    Personal{disabledScopes.personal && " (already exists)"}
                  </span>
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
                <SelectItem value="org_wide" disabled={disabledScopes.org_wide}>
                  <div className="flex items-center gap-2">
                    <Building2 className="h-4 w-4" />
                    <span>
                      Whole Organization{" "}
                      {disabledScopes.org_wide ? " (already exists)" : ""}
                    </span>
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
              <SelectTrigger id="chat-api-key-team">
                <SelectValue placeholder="Select a team" />
              </SelectTrigger>
              <SelectContent>
                {availableTeams.length === 0 ? (
                  <div className="p-2 text-sm text-muted-foreground">
                    All teams already have a {providerConfig.name} key
                  </div>
                ) : (
                  availableTeams.map((team) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
        )}

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
              {isEditMode && (
                <span className="text-muted-foreground font-normal">
                  (leave blank to keep current)
                </span>
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
      </div>
    </div>
  );
}
