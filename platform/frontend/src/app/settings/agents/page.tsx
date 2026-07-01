"use client";

import type { archestraApiTypes } from "@archestra/shared";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentSelector } from "@/components/agent-selector";
import { LlmModelSearchableSelect } from "@/components/llm-model-select";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import { QueryLoadError } from "@/components/query-load-error";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useOrgScopedAgents } from "@/lib/agent.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useLlmModels } from "@/lib/llm-models.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useArchestraMcpIdentity } from "@/lib/mcp/archestra-mcp-server";
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

type GlobalToolPolicy = NonNullable<
  NonNullable<
    archestraApiTypes.UpdateSecuritySettingsData["body"]
  >["globalToolPolicy"]
>;

type DiscoveredToolPolicy = NonNullable<
  NonNullable<
    archestraApiTypes.UpdateSecuritySettingsData["body"]
  >["discoveredToolPolicy"]
>;

type FileUploadsEnabled = "enabled" | "disabled";

export default function AgentSettingsPage() {
  const { getToolName } = useArchestraMcpIdentity();
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
  const [toolPolicy, setToolPolicy] = useState<GlobalToolPolicy>("permissive");
  const [discoveredToolPolicy, setDiscoveredToolPolicy] =
    useState<DiscoveredToolPolicy>("relaxed");
  const [fileUploads, setFileUploads] = useState<FileUploadsEnabled>("enabled");
  const initializedRef = useRef(false);
  const savedStateRef = useRef<AgentSettingsState>({
    selectedApiKeyId: "",
    defaultModel: "",
    defaultAgentId: "",
  });
  const savedSecurityStateRef = useRef({
    toolPolicy: "permissive" as GlobalToolPolicy,
    discoveredToolPolicy: "relaxed" as DiscoveredToolPolicy,
    fileUploads: "enabled" as FileUploadsEnabled,
  });

  const {
    data: allModels,
    isPending: modelsLoading,
    isLoadingError: isModelsLoadError,
    refetch: refetchModels,
  } = useLlmModels({
    apiKeyId: selectedApiKeyId || undefined,
  });

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
    setToolPolicy(organization.globalToolPolicy ?? "permissive");
    setDiscoveredToolPolicy(organization.discoveredToolPolicy ?? "relaxed");
    setFileUploads(
      (organization.allowChatFileUploads ?? true) ? "enabled" : "disabled",
    );
    savedStateRef.current = state;
    savedSecurityStateRef.current = {
      toolPolicy: organization.globalToolPolicy ?? "permissive",
      discoveredToolPolicy: organization.discoveredToolPolicy ?? "relaxed",
      fileUploads:
        (organization.allowChatFileUploads ?? true) ? "enabled" : "disabled",
    };
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
    toolPolicy !== savedSecurityStateRef.current.toolPolicy ||
    discoveredToolPolicy !==
      savedSecurityStateRef.current.discoveredToolPolicy ||
    fileUploads !== savedSecurityStateRef.current.fileUploads;

  const handleSave = async () => {
    if (!apiKeys) return;

    if (changes.hasChanges) {
      const payload = buildSavePayload(localState, savedStateRef.current);
      await updateAgentMutation.mutateAsync(payload);
      savedStateRef.current = { ...localState };
    }

    if (securityHasChanges) {
      await updateSecurityMutation.mutateAsync({
        globalToolPolicy: toolPolicy,
        discoveredToolPolicy,
        allowChatFileUploads: fileUploads === "enabled",
      });
      savedSecurityStateRef.current = {
        toolPolicy,
        discoveredToolPolicy,
        fileUploads,
      };
    }

    initializedRef.current = false;
  };

  const handleCancel = () => {
    const saved = savedStateRef.current;
    setSelectedApiKeyId(saved.selectedApiKeyId);
    setDefaultModel(saved.defaultModel);
    setDefaultAgentId(saved.defaultAgentId);
    setToolPolicy(savedSecurityStateRef.current.toolPolicy);
    setDiscoveredToolPolicy(savedSecurityStateRef.current.discoveredToolPolicy);
    setFileUploads(savedSecurityStateRef.current.fileUploads);
  };

  const modelItems = useMemo(() => {
    if (!allModels) return [];
    return allModels.map((model) => ({
      value: model.dbId,
      model: model.displayName ?? model.id,
      modelId: model.id,
      provider: model.provider,
      isFree: model.isFree,
      isBest: model.isBest,
    }));
  }, [allModels]);

  const selectedApiKey = useMemo(
    () => availableKeys.find((key) => key.id === selectedApiKeyId) ?? null,
    [availableKeys, selectedApiKeyId],
  );
  const canFilterFreeModels = selectedApiKey?.provider === "openrouter";

  const handleAgentChange = useCallback((value: string) => {
    setDefaultAgentId(value === "__personal__" ? "" : value);
  }, []);

  const handleResetDefaultModel = useCallback(() => {
    setSelectedApiKeyId("");
    setDefaultModel("");
  }, []);

  const isRestrictive = toolPolicy === "restrictive";
  const isDiscoveredRestrictive = discoveredToolPolicy === "apply_policies";
  const isSaving =
    updateAgentMutation.isPending || updateSecurityMutation.isPending;

  return (
    <SettingsSectionStack>
      <SettingsBlock
        title="Default model for agents and new chats"
        description="Select the LLM provider API key and model that will be used by default when creating new agents and starting new chat conversations."
        control={
          <WithPermissions
            permissions={{ agentSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) =>
              isLoadError ? (
                <QueryLoadError
                  title="Couldn't load your LLM providers"
                  className="w-80"
                  onRetry={() => {
                    refetchApiKeys();
                    refetchModels();
                  }}
                />
              ) : (
                <div className="flex flex-col gap-2 w-80">
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
                    triggerClassName="w-80"
                    popoverClassName="w-80"
                    emptyTriggerLabel="Select API key..."
                  />
                  <LlmModelSearchableSelect
                    value={defaultModel}
                    onValueChange={setDefaultModel}
                    options={modelItems}
                    freeFilterable={canFilterFreeModels}
                    placeholder={
                      !selectedApiKeyId
                        ? "Select API key first..."
                        : modelsLoading
                          ? "Loading models..."
                          : "Select model..."
                    }
                    className="w-80"
                    disabled={
                      isSaving ||
                      !hasPermission ||
                      modelsLoading ||
                      !selectedApiKeyId
                    }
                  />
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
        title="Default agent"
        description={`The default agent is preselected for all new chat conversations. To enable agent routing, assign ${getToolName("swap_agent")} to the default agent so it can swap to other agents, and ${getToolName("swap_to_default_agent")} to other agents so they can swap back automatically.`}
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
                className="w-80"
                disabled={isSaving || !hasPermission}
                hint="Only org-wide agents are shown"
                personalDefaultOption={{
                  value: "__personal__",
                  label: "User's personal agent",
                }}
              />
            )}
          </WithPermissions>
        }
      />
      <SettingsBlock
        title="Agentic Security Engine"
        description="Configure the default security policy for tool execution and result treatment."
        control={
          <WithPermissions
            permissions={{ agentSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <Select
                value={toolPolicy}
                onValueChange={(value: GlobalToolPolicy) =>
                  setToolPolicy(value)
                }
                disabled={isSaving || !hasPermission}
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="permissive">Disabled</SelectItem>
                  <SelectItem value="restrictive">Enabled</SelectItem>
                </SelectContent>
              </Select>
            )}
          </WithPermissions>
        }
        notice={
          isRestrictive ? (
            <span className="text-green-600 dark:text-green-400">
              Policies apply to agents' tools.{" "}
              <Link
                href="/mcp/tool-guardrails"
                className="text-primary hover:underline"
              >
                Configure policies
              </Link>
            </span>
          ) : (
            <span className="text-red-600 dark:text-red-400">
              Agents can perform any action. Tool calls are allowed and results
              are safe.
            </span>
          )
        }
      />
      <SettingsBlock
        title="Discovered Tool Policy"
        description="Default security policy for tools auto-discovered via the LLM proxy."
        control={
          <WithPermissions
            permissions={{ agentSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <Select
                value={discoveredToolPolicy}
                onValueChange={(value: DiscoveredToolPolicy) =>
                  setDiscoveredToolPolicy(value)
                }
                disabled={isSaving || !hasPermission}
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="relaxed">Relaxed</SelectItem>
                  <SelectItem value="apply_policies">Apply policies</SelectItem>
                </SelectContent>
              </Select>
            )}
          </WithPermissions>
        }
        notice={
          isDiscoveredRestrictive ? (
            <span className="text-green-600 dark:text-green-400">
              Policies apply to tools discovered via the LLM proxy.{" "}
              <Link
                href="/mcp/tool-guardrails"
                className="text-primary hover:underline"
              >
                Configure policies
              </Link>
            </span>
          ) : (
            <span className="text-muted-foreground">
              Tools discovered via the LLM proxy are allowed by default, so
              clients like Claude Code keep working under a restrictive global
              policy.
            </span>
          )
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
      <SettingsSaveBar
        hasChanges={changes.hasChanges || securityHasChanges}
        disabledSave={selectedApiKeyId !== "" && defaultModel === ""}
        isSaving={isSaving}
        permissions={{ agentSettings: ["update"] }}
        onSave={handleSave}
        onCancel={handleCancel}
      />
    </SettingsSectionStack>
  );
}
