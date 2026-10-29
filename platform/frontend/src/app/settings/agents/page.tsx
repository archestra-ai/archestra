"use client";

import {
  DocsPage,
  getDocsUrl,
  MESSAGING_CHANNEL_LABELS,
  type MessagingChannelId,
  PopularAgentIdSchema,
  providerSupportsChat,
} from "@archestra/shared";
import { AlertTriangle, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { siKubernetes } from "simple-icons";
import {
  AGENT_CATALOG_TEMPLATE_NAMES,
  CatalogAgentIcon,
} from "@/components/agent-pages/agent-catalog";
import { AgentRuntimeUnavailableNotice } from "@/components/agent-runtime-unavailable-notice";
import { AgentSelector } from "@/components/agent-selector";
import { ButtonWithTooltip } from "@/components/button-with-tooltip";
import { ChannelIcon } from "@/components/channel-icon";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { LlmModelSearchableSelect } from "@/components/llm-model-select";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import {
  EMPTY_MODEL_TIERS,
  ModelTierPickers,
  type ModelTierSelection,
} from "@/components/model-tier-pickers";
import { QueryLoadError } from "@/components/query-load-error";
import { WithPermissions } from "@/components/roles/with-permissions";
import { IntegrationAvailabilitySection } from "@/components/settings/integration-availability-section";
import {
  SettingsBlock,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { TableRowActions } from "@/components/table-row-actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import { Switch } from "@/components/ui/switch";
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { isPersonalSubscription } from "@/lib/llm-key-subscription";
import { useLlmModels } from "@/lib/llm-models.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import {
  useIsGlobalAdmin,
  useOrganization,
  useUpdateAgentSettings,
  useUpdateSecuritySettings,
} from "@/lib/organization.query";
import { cn } from "@/lib/utils/tailwind";
import {
  type AgentSettingsState,
  buildSavePayload,
  detectChanges,
  resolveInitialState,
} from "./agent-settings-utils";

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
  const [tiers, setTiers] = useState<ModelTierSelection>(EMPTY_MODEL_TIERS);
  const [defaultAgentId, setDefaultAgentId] = useState<string>("");
  const [fileUploads, setFileUploads] = useState(true);
  const [playwrightEnabled, setPlaywrightEnabled] = useState(true);
  const savedPlaywrightRef = useRef(true);
  const { isGlobalAdmin } = useIsGlobalAdmin();
  const initializedRef = useRef(false);
  const savedStateRef = useRef<AgentSettingsState>({
    selectedApiKeyId: "",
    defaultModel: "",
    tiers: EMPTY_MODEL_TIERS,
    defaultAgentId: "",
  });
  const savedFileUploadsRef = useRef(true);
  const runtimeBackend = useFeature("agentRuntimeBackend");
  const runtimeEnabled = useFeature("agentRuntime");

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
    setTiers(state.tiers);
    setDefaultAgentId(state.defaultAgentId);
    const savedFileUploads = organization.allowChatFileUploads ?? true;
    setPlaywrightEnabled(organization.playwrightMcpEnabled);
    savedPlaywrightRef.current = organization.playwrightMcpEnabled;
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
    tiers,
    defaultAgentId,
  };

  const changes = detectChanges(localState, savedStateRef.current);
  const securityHasChanges =
    fileUploads !== savedFileUploadsRef.current ||
    playwrightEnabled !== savedPlaywrightRef.current;

  const handleSave = async () => {
    if (!apiKeys) return;

    if (changes.hasChanges) {
      const payload = buildSavePayload(localState, savedStateRef.current);
      await updateAgentMutation.mutateAsync(payload);
      savedStateRef.current = { ...localState };
    }

    if (securityHasChanges) {
      await updateSecurityMutation.mutateAsync({
        allowChatFileUploads: fileUploads,
        ...(isGlobalAdmin && playwrightEnabled !== savedPlaywrightRef.current
          ? { playwrightMcpEnabled: playwrightEnabled }
          : {}),
      });
      savedFileUploadsRef.current = fileUploads;
      savedPlaywrightRef.current = playwrightEnabled;
    }

    initializedRef.current = false;
  };

  const handleCancel = () => {
    const saved = savedStateRef.current;
    setSelectedApiKeyId(saved.selectedApiKeyId);
    setDefaultModel(saved.defaultModel);
    setTiers(saved.tiers);
    setDefaultAgentId(saved.defaultAgentId);
    setFileUploads(savedFileUploadsRef.current);
    setPlaywrightEnabled(savedPlaywrightRef.current);
  };

  const modelItems = useMemo(() => {
    if (!allModels || isPlaceholderData) return [];
    return allModels.map((model) => ({
      value: model.dbId,
      model: model.displayName ?? model.id,
      modelId: model.id,
      provider: model.provider,
      isFree: model.isFree,
      isBest: model.isBest,
    }));
  }, [allModels, isPlaceholderData]);

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
    setTiers(EMPTY_MODEL_TIERS);
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
                      setTiers(EMPTY_MODEL_TIERS);
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
                  {selectedApiKey && defaultModel && (
                    <ModelTierPickers
                      apiKeyId={selectedApiKey.id}
                      provider={selectedApiKey.provider}
                      value={tiers}
                      onChange={setTiers}
                      disabled={isSaving || !hasPermission}
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
      <section className="space-y-3" aria-labelledby="chat-file-uploads-title">
        <h2
          id="chat-file-uploads-title"
          className="text-sm font-medium leading-5"
        >
          Chat File Uploads
        </h2>
        <InlineNotice variant="warning">
          <AlertTriangle />
          <InlineNoticeBody>
            <span className="font-medium">
              Uploads may contain sensitive information.
            </span>
            <InlineNoticeText>
              Files and extracted content may be sent to the chat's AI provider.
              Enable uploads only if your organization's data policies allow it.
            </InlineNoticeText>
          </InlineNoticeBody>
        </InlineNotice>
        <div className="flex items-center justify-between gap-4">
          <p
            id="chat-file-uploads-description"
            className="text-sm leading-5 text-muted-foreground"
          >{`Allow users to upload files in the ${appName} chat UI.`}</p>
          <WithPermissions
            permissions={{ organizationSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <Switch
                aria-label="Chat File Uploads"
                aria-describedby="chat-file-uploads-description"
                checked={fileUploads}
                onCheckedChange={setFileUploads}
                disabled={isSaving || !hasPermission}
              />
            )}
          </WithPermissions>
        </div>
      </section>
      <section className="space-y-3" aria-labelledby="built-in-browser-title">
        <h2
          id="built-in-browser-title"
          className="text-sm font-medium leading-5"
        >
          Built-in Browser (Playwright MCP)
        </h2>
        <div className="flex items-center justify-between gap-4">
          <p
            id="built-in-browser-description"
            className="text-sm leading-5 text-muted-foreground"
          >
            Allow agents to use the built-in browser. Disabling stops browser
            MCP runtimes in every environment and hides the Browser panel in
            chat.
          </p>
          <Switch
            aria-label="Built-in Browser (Playwright MCP)"
            aria-describedby="built-in-browser-description"
            checked={playwrightEnabled}
            onCheckedChange={setPlaywrightEnabled}
            disabled={isSaving || !isGlobalAdmin}
          />
        </div>
      </section>

      <SettingsSaveBar
        hasChanges={changes.hasChanges || securityHasChanges}
        disabledSave={selectedApiKeyId !== "" && defaultModel === ""}
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
      <section
        aria-labelledby="agent-runtime-heading"
        className="space-y-3 border-t pt-6"
      >
        <h2 id="agent-runtime-heading" className="text-base font-semibold">
          <span>Agent Runtime</span>{" "}
          <Badge
            variant="outline"
            className="align-middle border-transparent bg-sidebar-chip px-1.5 py-0 text-[10px] text-sidebar-emphasis dark:border-sidebar-emphasis dark:bg-sidebar"
          >
            Beta
          </Badge>
        </h2>
        {runtimeEnabled === false && <AgentRuntimeUnavailableNotice />}
        <div
          className={cn("space-y-6", runtimeEnabled !== true && "opacity-50")}
        >
          <IntegrationAvailabilitySection
            disabled={runtimeEnabled !== true}
            id="popular-agents"
            catalogKey="popularAgentOverrides"
            catalog={PopularAgentIdSchema.options}
            title="Agent Runtimes"
            description="Choose which Agent Runtimes are available when creating a new agent, and in what order."
            options={PopularAgentIdSchema.options.map((id) => ({
              value: id,
              label: AGENT_CATALOG_TEMPLATE_NAMES[id],
              icon: (
                <span className="flex size-3.5 shrink-0 items-center justify-center">
                  <CatalogAgentIcon id={id} size={14} />
                </span>
              ),
            }))}
            placeholder="Select Agent Runtimes…"
            emptyMessage="No agents found."
            savedMessage="Agent Runtimes updated"
          />
          {runtimeBackend && <RuntimeBackendSection />}
        </div>
      </section>
    </SettingsSectionStack>
  );
}

function RuntimeBackendSection() {
  return (
    <SettingsBlock
      id="runtime-backend"
      title="Runtime backend"
      description={
        <>
          Runtime backends provide the isolated environment where delegated
          Agent tasks run.{" "}
          <ExternalDocsLink
            href={getDocsUrl(DocsPage.PlatformAgentRuntime)}
            className="whitespace-nowrap"
          >
            Learn more
          </ExternalDocsLink>
        </>
      }
      control={
        <ButtonWithTooltip
          type="button"
          size="sm"
          disabled
          disabledText="Additional runtime backends are coming soon."
        >
          <Plus className="size-4" />
          <span>Add backend</span>
        </ButtonWithTooltip>
      }
    >
      <div className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background">
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              className="size-5"
              fill={`#${siKubernetes.hex}`}
            >
              <path d={siKubernetes.path} />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium">Kubernetes</h3>
            <p className="text-xs text-muted-foreground">
              Runs each delegated task in an isolated Kubernetes Job
            </p>
          </div>
        </div>
        <div className="self-end sm:self-auto">
          <TableRowActions
            itemName="Kubernetes"
            actions={[
              {
                icon: <Pencil className="size-4" />,
                label: "Edit",
                disabled: true,
                disabledTooltip:
                  "Backend configuration is managed by the deployment today.",
              },
              {
                icon: <Trash2 className="size-4" />,
                label: "Delete",
                variant: "destructive",
                disabled: true,
                disabledTooltip:
                  "Kubernetes is the only supported backend and cannot be removed.",
              },
            ]}
          />
        </div>
      </div>
    </SettingsBlock>
  );
}
