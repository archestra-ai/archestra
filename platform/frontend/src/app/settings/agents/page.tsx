"use client";

import {
  DocsPage,
  getDocsUrl,
  MESSAGING_CHANNEL_LABELS,
  type MessagingChannelId,
} from "@archestra/shared";
import { Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { siKubernetes } from "simple-icons";
import { AgentSelector } from "@/components/agent-selector";
import { ButtonWithTooltip } from "@/components/button-with-tooltip";
import { ChannelIcon } from "@/components/channel-icon";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { LlmModelSearchableSelect } from "@/components/llm-model-select";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import { QueryLoadError } from "@/components/query-load-error";
import { WithPermissions } from "@/components/roles/with-permissions";
import { ExecutionCredentialsSection } from "@/components/settings/execution-credentials-section";
import { IntegrationAvailabilitySection } from "@/components/settings/integration-availability-section";
import {
  SettingsBlock,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { TableRowActions } from "@/components/table-row-actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useOrgScopedAgents } from "@/lib/agent.query";
import {
  APPS_HACKATHON_DATE_RANGE_LABEL,
  APPS_HACKATHON_REGISTER_URL,
  APPS_HACKATHON_SETTING_ANCHOR,
  useAppsHackathonOffered,
} from "@/lib/app-session-recording/apps-hackathon";
import { type FeaturesResponse, useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { isPersonalSubscription } from "@/lib/llm-key-subscription";
import { useLlmModels } from "@/lib/llm-models.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import {
  useOrganization,
  useUpdateAgentSettings,
  useUpdateSecuritySettings,
} from "@/lib/organization.query";
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
  const { data: orgAgents } = useOrgScopedAgents();

  const [selectedApiKeyId, setSelectedApiKeyId] = useState<string>("");
  const [apiKeySelectorOpen, setApiKeySelectorOpen] = useState(false);
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [defaultAgentId, setDefaultAgentId] = useState<string>("");
  const [fileUploads, setFileUploads] = useState<FileUploadsEnabled>("enabled");
  const [hackathonRecorder, setHackathonRecorder] =
    useState<FileUploadsEnabled>("enabled");
  const initializedRef = useRef(false);
  const savedStateRef = useRef<AgentSettingsState>({
    selectedApiKeyId: "",
    defaultModel: "",
    defaultAgentId: "",
  });
  const savedFileUploadsRef = useRef<FileUploadsEnabled>("enabled");
  const savedHackathonRecorderRef = useRef<FileUploadsEnabled>("enabled");
  // Only offered while this deployment carries the hackathon and it is still
  // running; an enterprise deployment never does, so there is nothing here to
  // switch on. Past the closing date the whole section goes rather than
  // lingering as a switch that no longer changes anything.
  const hackathonOffered = useAppsHackathonOffered();
  const executionBackend = useFeature("agentBackgroundExecutionBackend");

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
    const savedHackathonRecorder: FileUploadsEnabled =
      (organization.appsHackathonRecorderEnabled ?? true)
        ? "enabled"
        : "disabled";
    setHackathonRecorder(savedHackathonRecorder);
    savedStateRef.current = state;
    savedFileUploadsRef.current = savedFileUploads;
    savedHackathonRecorderRef.current = savedHackathonRecorder;
    initializedRef.current = true;
  }, [organization, apiKeys]);

  const availableKeys = apiKeys ?? [];

  const localState: AgentSettingsState = {
    selectedApiKeyId,
    defaultModel,
    defaultAgentId,
  };

  const changes = detectChanges(localState, savedStateRef.current);
  const securityHasChanges =
    fileUploads !== savedFileUploadsRef.current ||
    hackathonRecorder !== savedHackathonRecorderRef.current;

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
        // Only sent when the section was actually shown. Otherwise every
        // unrelated save here would carry a value for a setting this admin was
        // never offered — and on a deployment without the hackathon that value
        // is a default, not a decision.
        ...(hackathonOffered
          ? { appsHackathonRecorderEnabled: hackathonRecorder === "enabled" }
          : {}),
      });
      savedFileUploadsRef.current = fileUploads;
      savedHackathonRecorderRef.current = hackathonRecorder;
    }

    initializedRef.current = false;
  };

  const handleCancel = () => {
    const saved = savedStateRef.current;
    setSelectedApiKeyId(saved.selectedApiKeyId);
    setDefaultModel(saved.defaultModel);
    setDefaultAgentId(saved.defaultAgentId);
    setFileUploads(savedFileUploadsRef.current);
    setHackathonRecorder(savedHackathonRecorderRef.current);
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
            permissions={{ agentSettings: ["update"] }}
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
            permissions={{ agentSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <AgentSelector
                mode="single"
                value={defaultAgentId || "__personal__"}
                onValueChange={handleAgentChange}
                agents={orgAgents ?? []}
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
            permissions={{ agentSettings: ["update"] }}
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
      {hackathonOffered && (
        <SettingsBlock
          id={APPS_HACKATHON_SETTING_ANCHOR}
          title="Apps Hackathon Recorder"
          description={
            <>
              {/* white-label-ok: names the real Archestra-run hackathon and its repo; hidden unless that offer is enabled */}
              Show the session recorder control panel in chat composer to
              participate in Archestra Apps Hackathon{" "}
              {APPS_HACKATHON_DATE_RANGE_LABEL}.{" "}
              <a
                href={APPS_HACKATHON_REGISTER_URL}
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium text-primary underline underline-offset-2"
              >
                Learn more.
              </a>
            </>
          }
          control={
            <WithPermissions
              permissions={{ agentSettings: ["update"] }}
              noPermissionHandle="tooltip"
            >
              {({ hasPermission }) => (
                <Select
                  value={hackathonRecorder}
                  onValueChange={(value: FileUploadsEnabled) =>
                    setHackathonRecorder(value)
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
        />
      )}
      <SettingsSaveBar
        hasChanges={changes.hasChanges || securityHasChanges}
        disabledSave={selectedApiKeyId !== "" && defaultModel === ""}
        isSaving={isSaving}
        permissions={{ agentSettings: ["update"] }}
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
      {executionBackend && (
        <>
          <ExecutionCredentialsSection />
          <ExecutionBackendSection executionBackend={executionBackend} />
        </>
      )}
    </SettingsSectionStack>
  );
}

type ExecutionBackend = NonNullable<
  FeaturesResponse["agentBackgroundExecutionBackend"]
>;

function ExecutionBackendSection({
  executionBackend,
}: {
  executionBackend: ExecutionBackend;
}) {
  return (
    <SettingsBlock
      id="execution-backend"
      title="Execution backend"
      description={
        <>
          Execution backends provide the isolated environment where delegated
          Agent tasks run.{" "}
          <ExternalDocsLink
            href={getDocsUrl(DocsPage.PlatformAgentBackgroundExecution)}
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
          disabledText="Additional execution backends are coming soon."
        >
          <Plus className="size-4" />
          <span>Add backend</span>
        </ButtonWithTooltip>
      }
      notice={
        !executionBackend.available
          ? "The feature is enabled, but the Kubernetes backend is unreachable. Check the orchestrator configuration."
          : undefined
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
