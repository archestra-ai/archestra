"use client";

import type { archestraApiTypes } from "@archestra/shared";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentSelector } from "@/components/agent-selector";
import { CallPolicyToggle } from "@/components/call-policy-toggle";
import { LlmModelSearchableSelect } from "@/components/llm-model-select";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import { QueryLoadError } from "@/components/query-load-error";
import { ResultPolicyToggle } from "@/components/result-policy-toggle";
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
import type { CallPolicyAction, ResultPolicyAction } from "@/lib/policy.utils";
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
  const [fileUploads, setFileUploads] = useState<FileUploadsEnabled>("enabled");
  const [defaultInvocationPolicy, setDefaultInvocationPolicy] =
    useState<CallPolicyAction>("allow_when_context_is_untrusted");
  const [defaultResultPolicy, setDefaultResultPolicy] =
    useState<ResultPolicyAction>("mark_as_untrusted");
  const initializedRef = useRef(false);
  const savedStateRef = useRef<AgentSettingsState>({
    selectedApiKeyId: "",
    defaultModel: "",
    defaultAgentId: "",
  });
  const savedSecurityStateRef = useRef({
    toolPolicy: "permissive" as GlobalToolPolicy,
    fileUploads: "enabled" as FileUploadsEnabled,
    defaultInvocationPolicy:
      "allow_when_context_is_untrusted" as CallPolicyAction,
    defaultResultPolicy: "mark_as_untrusted" as ResultPolicyAction,
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
    setFileUploads(
      (organization.allowChatFileUploads ?? true) ? "enabled" : "disabled",
    );
    setDefaultInvocationPolicy(
      organization.defaultDiscoveredToolInvocationPolicy ??
        "allow_when_context_is_untrusted",
    );
    setDefaultResultPolicy(
      organization.defaultDiscoveredToolResultPolicy ?? "mark_as_untrusted",
    );
    savedStateRef.current = state;
    savedSecurityStateRef.current = {
      toolPolicy: organization.globalToolPolicy ?? "permissive",
      fileUploads:
        (organization.allowChatFileUploads ?? true) ? "enabled" : "disabled",
      defaultInvocationPolicy:
        organization.defaultDiscoveredToolInvocationPolicy ??
        "allow_when_context_is_untrusted",
      defaultResultPolicy:
        organization.defaultDiscoveredToolResultPolicy ?? "mark_as_untrusted",
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
    fileUploads !== savedSecurityStateRef.current.fileUploads ||
    defaultInvocationPolicy !==
      savedSecurityStateRef.current.defaultInvocationPolicy ||
    defaultResultPolicy !== savedSecurityStateRef.current.defaultResultPolicy;

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
        allowChatFileUploads: fileUploads === "enabled",
        defaultDiscoveredToolInvocationPolicy: defaultInvocationPolicy,
        defaultDiscoveredToolResultPolicy: defaultResultPolicy,
      });
      savedSecurityStateRef.current = {
        toolPolicy,
        fileUploads,
        defaultInvocationPolicy,
        defaultResultPolicy,
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
    setFileUploads(savedSecurityStateRef.current.fileUploads);
    setDefaultInvocationPolicy(
      savedSecurityStateRef.current.defaultInvocationPolicy,
    );
    setDefaultResultPolicy(savedSecurityStateRef.current.defaultResultPolicy);
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
        title="Default Agent"
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
      >
        <WithPermissions
          permissions={{ agentSettings: ["update"] }}
          noPermissionHandle="tooltip"
        >
          {({ hasPermission }) => (
            <div className="flex flex-col gap-4">
              <div>
                <h3 className="font-semibold leading-none">
                  Default Guardrails for Discovered Tools
                </h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Archestra records new tools your agents call through the LLM
                  Proxy and gives each these starting guardrails.{" "}
                  <span className="font-medium text-foreground">
                    Call Policy
                  </span>{" "}
                  controls whether a tool may run;{" "}
                  <span className="font-medium text-foreground">
                    Results are
                  </span>{" "}
                  controls how its output is treated. Existing tools keep their
                  policies — adjust any tool policy under{" "}
                  <Link
                    href="/mcp/tool-guardrails"
                    className="text-primary hover:underline"
                  >
                    Tool Guardrails
                  </Link>
                  .
                </p>
              </div>
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm font-medium">Call Policy</p>
                <div className="flex w-[150px] justify-start">
                  <CallPolicyToggle
                    size="sm"
                    value={defaultInvocationPolicy}
                    onChange={setDefaultInvocationPolicy}
                    disabled={isSaving || !hasPermission}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm font-medium">Results are</p>
                <div className="flex w-[150px] justify-start">
                  <ResultPolicyToggle
                    size="sm"
                    value={defaultResultPolicy}
                    onChange={setDefaultResultPolicy}
                    disabled={isSaving || !hasPermission}
                  />
                </div>
              </div>
            </div>
          )}
        </WithPermissions>
      </SettingsBlock>
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
