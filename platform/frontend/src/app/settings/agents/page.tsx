"use client";

import {
  getAgentRuntimeDefaultModelCompatibility,
  isClaudeCodeRuntimeCommand,
  MESSAGING_CHANNEL_LABELS,
  type MessagingChannelId,
  providerSupportsChat,
  type SupportedProvider,
} from "@archestra/shared";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentSelector } from "@/components/agent-selector";
import { ChannelIcon } from "@/components/channel-icon";
import { LlmModelSearchableSelect } from "@/components/llm-model-select";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import { QueryLoadError } from "@/components/query-load-error";
import { WithPermissions } from "@/components/roles/with-permissions";
import { IntegrationAvailabilitySection } from "@/components/settings/integration-availability-section";
import {
  SettingsBlock,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppName } from "@/lib/hooks/use-app-name";
import { isPersonalSubscription } from "@/lib/llm-key-subscription";
import { useLlmModels } from "@/lib/llm-models.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import {
  useDefaultModelRuntimeDependents,
  useOrganization,
  useUpdateAgentSettings,
  useUpdateSecuritySettings,
} from "@/lib/organization.query";
import { DefaultModelBlockedBadge } from "./_parts/default-model-blocked-badge";
import type { RuntimeAgent } from "./_parts/runtime-agent";
import {
  type AgentSettingsState,
  buildSavePayload,
  detectChanges,
  resolveInitialState,
} from "./agent-settings-utils";

type FileUploadsEnabled = "enabled" | "disabled";

const MESSAGING_CHANNEL_LABELS_KEYS = Object.keys(
  MESSAGING_CHANNEL_LABELS,
) as MessagingChannelId[];

export default function AgentSettingsPage() {
  const appName = useAppName();
  const { data: organization } = useOrganization();
  const {
    data: apiKeys,
    isLoadingError: isApiKeysLoadError,
    refetch: refetchApiKeys,
  } = useAvailableLlmProviderApiKeys({ toastOnError: false });

  const [selectedApiKeyId, setSelectedApiKeyId] = useState<string>("");
  const [apiKeySelectorOpen, setApiKeySelectorOpen] = useState(false);
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [defaultAgentId, setDefaultAgentId] = useState<string>("");
  const [fileUploads, setFileUploads] = useState<FileUploadsEnabled>("enabled");
  const initializedRef = useRef(false);
  const savedStateRef = useRef<AgentSettingsState>({
    selectedApiKeyId: "",
    defaultModel: "",
    defaultAgentId: "",
  });
  const savedFileUploadsRef = useRef<FileUploadsEnabled>("enabled");

  const {
    data: allModels,
    isPending: modelsLoading,
    isLoadingError: isModelsLoadError,
    isPlaceholderData,
    refetch: refetchModels,
  } = useLlmModels({
    apiKeyId: selectedApiKeyId || undefined,
  });

  // `useLlmModels` uses `keepPreviousData`, so after a key switch `data` still
  // holds the previous key's models (isPlaceholderData). Treat that as loading
  // for the new key so the admin can't save a model from the old provider
  // against the new provider's key.
  const modelsPending = modelsLoading || isPlaceholderData;

  const isLoadError = isApiKeysLoadError || isModelsLoadError;

  const updateAgentMutation = useUpdateAgentSettings(
    "Agent settings updated",
    "Failed to update agent settings",
  );
  const updateSecurityMutation = useUpdateSecuritySettings(
    "Agent settings updated",
    "Failed to update agent settings",
  );

  useEffect(() => {
    if (!organization || !apiKeys) return;
    if (initializedRef.current) return;

    const state = resolveInitialState(organization, apiKeys);
    setSelectedApiKeyId(state.selectedApiKeyId);
    setDefaultModel(state.defaultModel);
    setDefaultAgentId(state.defaultAgentId);
    const savedFileUploads: FileUploadsEnabled =
      (organization.allowChatFileUploads ?? true) ? "enabled" : "disabled";
    setFileUploads(savedFileUploads);
    savedStateRef.current = state;
    savedFileUploadsRef.current = savedFileUploads;
    initializedRef.current = true;
  }, [organization, apiKeys]);

  // The default model answers chats, so a key whose provider cannot chat
  // (embeddings-only, decisions-only) is never offered for it.
  const availableKeys = useMemo(
    () => (apiKeys ?? []).filter((key) => providerSupportsChat(key.provider)),
    [apiKeys],
  );

  const localState: AgentSettingsState = {
    selectedApiKeyId,
    defaultModel,
    defaultAgentId,
  };

  const changes = detectChanges(localState, savedStateRef.current);
  const securityHasChanges = fileUploads !== savedFileUploadsRef.current;

  const handleSave = async () => {
    if (!apiKeys) return;

    if (changes.hasChanges) {
      const payload = buildSavePayload(localState, savedStateRef.current);
      await updateAgentMutation.mutateAsync(payload);
      savedStateRef.current = { ...localState };
    }

    if (securityHasChanges) {
      await updateSecurityMutation.mutateAsync({
        allowChatFileUploads: fileUploads === "enabled",
      });
      savedFileUploadsRef.current = fileUploads;
    }

    initializedRef.current = false;
  };

  const handleCancel = () => {
    const saved = savedStateRef.current;
    setSelectedApiKeyId(saved.selectedApiKeyId);
    setDefaultModel(saved.defaultModel);
    setDefaultAgentId(saved.defaultAgentId);
    setFileUploads(savedFileUploadsRef.current);
  };

  // Agent Runtime agents with no model of their own run on this default, so
  // a model their runtime can't serve would break them. Check every option
  // up front, with the same rule the server applies on save.
  const { data: runtimeDependents, isPlaceholderData: dependentsLoading } =
    useDefaultModelRuntimeDependents({ modelId: defaultModel || null });
  // Agents the viewer can't read: the server counts them for the selected
  // model only, and never says more.
  const hiddenBlockingCount = dependentsLoading
    ? 0
    : (runtimeDependents?.hiddenBlockingCount ?? 0);
  const blockedBy = useCallback(
    (model: {
      provider: SupportedProvider;
      id: string;
      capabilities?: { supportedEndpoints?: string[] | null };
    }) => {
      const reasonFor = (agent: RuntimeAgent) => {
        const result = getAgentRuntimeDefaultModelCompatibility({
          ...agent,
          provider: model.provider,
          modelId: model.id,
          supportedEndpoints: model.capabilities?.supportedEndpoints,
        });
        return result.compatible ? null : result.message;
      };
      const agents = (runtimeDependents?.agents ?? []).filter(
        (agent) => reasonFor(agent) !== null,
      );
      return {
        agents,
        reason: agents[0] ? reasonFor(agents[0]) : null,
        // Only agents the viewer can read say anything about their runtime.
        allClaudeCode:
          agents.length > 0 &&
          agents.every((agent) =>
            isClaudeCodeRuntimeCommand(agent.runtimeCommand?.[0]),
          ),
      };
    },
    [runtimeDependents],
  );

  const modelItems = useMemo(() => {
    if (!allModels || isPlaceholderData) return [];
    return allModels.map((model) => {
      const blocking = blockedBy(model).agents.length;
      return {
        value: model.dbId,
        model: model.displayName ?? model.id,
        modelId: model.id,
        provider: model.provider,
        isFree: model.isFree,
        isBest: model.isBest,
        description:
          blocking > 0
            ? `Can't run ${blocking} Agent Runtime ${blocking === 1 ? "agent" : "agents"}`
            : undefined,
      };
    });
  }, [allModels, isPlaceholderData, blockedBy]);

  const selectedModel = useMemo(
    () =>
      isPlaceholderData
        ? undefined
        : allModels?.find((model) => model.dbId === defaultModel),
    [allModels, defaultModel, isPlaceholderData],
  );
  const blocked = selectedModel ? blockedBy(selectedModel) : null;

  const selectedApiKey = useMemo(
    () => availableKeys.find((key) => key.id === selectedApiKeyId) ?? null,
    [availableKeys, selectedApiKeyId],
  );
  const selectedApiKeyIsSubscription =
    selectedApiKey !== null && isPersonalSubscription(selectedApiKey);
  const canFilterFreeModels = selectedApiKey?.provider === "openrouter";

  const handleAgentChange = useCallback((value: string) => {
    setDefaultAgentId(value === "__personal__" ? "" : value);
  }, []);

  const handleResetDefaultModel = useCallback(() => {
    setSelectedApiKeyId("");
    setDefaultModel("");
  }, []);

  const isSaving =
    updateAgentMutation.isPending || updateSecurityMutation.isPending;

  return (
    <SettingsSectionStack>
      <SettingsBlock
        title="Default Model for Agents and New Chats"
        description={
          <>
            Select the LLM provider API key and model that will be used by
            default when creating new agents and starting new chat
            conversations.
            <span className="mt-2 block">
              It's also the fallback for {appName}'s{" "}
              <Link
                href="/agents?scope=built_in"
                className="text-primary hover:underline"
              >
                built-in agents
              </Link>{" "}
              — like chat title generation and context compaction — when they
              don't have their own model.
            </span>
          </>
        }
        control={
          <WithPermissions
            permissions={{ organizationSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) =>
              isLoadError ? (
                <QueryLoadError
                  title="Couldn't load your LLM providers"
                  className="w-full sm:w-80"
                  onRetry={() => {
                    refetchApiKeys();
                    refetchModels();
                  }}
                />
              ) : (
                <div className="flex w-full flex-col gap-2 sm:w-80">
                  <LlmProviderApiKeyDropdown
                    availableKeys={availableKeys}
                    selectedApiKeyId={selectedApiKeyId || null}
                    disabled={isSaving || !hasPermission}
                    open={apiKeySelectorOpen}
                    onOpenChange={setApiKeySelectorOpen}
                    onSelectKey={(value) => {
                      setSelectedApiKeyId(value);
                      setDefaultModel("");
                      setApiKeySelectorOpen(false);
                    }}
                    triggerVariant="select"
                    triggerClassName="w-full"
                    popoverClassName="w-80"
                    emptyTriggerLabel="Select provider key..."
                  />
                  <LlmModelSearchableSelect
                    value={defaultModel}
                    onValueChange={setDefaultModel}
                    options={modelItems}
                    freeFilterable={canFilterFreeModels}
                    placeholder={
                      !selectedApiKeyId
                        ? "Select provider key first..."
                        : modelsPending
                          ? "Loading models..."
                          : "Select model..."
                    }
                    className="w-full"
                    disabled={
                      isSaving ||
                      !hasPermission ||
                      modelsPending ||
                      !selectedApiKeyId
                    }
                  />
                  {selectedModel && (
                    <DefaultModelBlockedBadge
                      agents={blocked?.agents ?? []}
                      hiddenCount={hiddenBlockingCount}
                      reason={
                        blocked?.allClaudeCode
                          ? "Claude Code runs only Anthropic models, or Claude on Bedrock or Vertex."
                          : (blocked?.reason ??
                            "Their Agent Runtime can't use this model.")
                      }
                      allClaudeCode={blocked?.allClaudeCode ?? false}
                      modelName={selectedModel.displayName ?? selectedModel.id}
                    />
                  )}
                  {selectedApiKeyIsSubscription && (
                    <Alert>
                      <AlertDescription>
                        Each person using chat must connect their own
                        subscription account. No credential is shared.
                      </AlertDescription>
                    </Alert>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="self-end"
                    onClick={handleResetDefaultModel}
                    disabled={
                      isSaving ||
                      !hasPermission ||
                      (!selectedApiKeyId && !defaultModel)
                    }
                  >
                    Reset
                  </Button>
                </div>
              )
            }
          </WithPermissions>
        }
      />
      <SettingsBlock
        title="Default Agent"
        description="Preselected for new chats, for every member who has not set a personal default agent of their own."
        control={
          <WithPermissions
            permissions={{ organizationSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <AgentSelector
                mode="single"
                value={defaultAgentId || "__personal__"}
                onValueChange={handleAgentChange}
                remote={{
                  filters: {
                    agentType: "agent",
                    excludeBuiltIn: true,
                    scope: "org",
                  },
                }}
                placeholder="Select agent..."
                searchPlaceholder="Search agents..."
                className="w-full sm:w-80"
                disabled={isSaving || !hasPermission}
                hint="Only org-wide agents are shown"
                sentinelOption={{
                  value: "__personal__",
                  label: "User's personal agent",
                }}
              />
            )}
          </WithPermissions>
        }
      />
      <SettingsBlock
        title="Chat File Uploads"
        description={`Allow users to upload files in the ${appName} chat UI.`}
        control={
          <WithPermissions
            permissions={{ organizationSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <Select
                value={fileUploads}
                onValueChange={(value: FileUploadsEnabled) =>
                  setFileUploads(value)
                }
                disabled={isSaving || !hasPermission}
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="enabled">Enabled</SelectItem>
                  <SelectItem value="disabled">Disabled</SelectItem>
                </SelectContent>
              </Select>
            )}
          </WithPermissions>
        }
        notice={
          <span className="text-red-600 dark:text-red-400">
            Security policies only apply to text content. File uploads (images,
            PDFs) bypass policy checks. File-based policies coming soon.
          </span>
        }
      />

      <SettingsSaveBar
        hasChanges={changes.hasChanges || securityHasChanges}
        disabledSave={
          (selectedApiKeyId !== "" && defaultModel === "") ||
          (changes.hasModelChanges &&
            (blocked?.agents.length ?? 0) + hiddenBlockingCount > 0)
        }
        isSaving={isSaving}
        permissions={{ organizationSettings: ["update"] }}
        onSave={handleSave}
        onCancel={handleCancel}
      />
      <IntegrationAvailabilitySection
        id="available-messaging-channels"
        catalogKey="messagingChannelOverrides"
        catalog={MESSAGING_CHANNEL_LABELS_KEYS}
        title="Available messaging channels"
        description="Which channels agents can be configured on and reached through. A channel you remove stops listening — a connected Slack bot stops answering, and email stops reaching agents."
        options={MESSAGING_CHANNEL_LABELS_KEYS.map((channel) => ({
          value: channel,
          label: MESSAGING_CHANNEL_LABELS[channel],
          icon: <ChannelIcon channel={channel} />,
        }))}
        placeholder="Select channels…"
        emptyMessage="No channels found."
        savedMessage="Available messaging channels updated"
      />
    </SettingsSectionStack>
  );
}
