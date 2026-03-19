"use client";

import type { archestraApiTypes } from "@shared";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PROVIDER_CONFIG } from "@/components/chat-api-key-form";
import { LlmModelSearchableSelect } from "@/components/llm-model-select";
import {
  LlmProviderApiKeyOptionLabel,
  LlmProviderApiKeySelectItems,
} from "@/components/llm-provider-options";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
  SettingsSectionStack,
} from "@/components/settings/settings-block";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useOrgScopedAgents } from "@/lib/agent.query";
import { useChatModels } from "@/lib/chat-models.query";
import { useAvailableChatApiKeys } from "@/lib/chat-settings.query";
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

type FileUploadsEnabled = "enabled" | "disabled";

export default function AgentSettingsPage() {
  const { data: organization } = useOrganization();
  const { data: apiKeys } = useAvailableChatApiKeys();
  const { data: orgAgents } = useOrgScopedAgents();

  const [selectedApiKeyId, setSelectedApiKeyId] = useState<string>("");
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [defaultAgentId, setDefaultAgentId] = useState<string>("");
  const [toolPolicy, setToolPolicy] = useState<GlobalToolPolicy>("permissive");
  const [fileUploads, setFileUploads] = useState<FileUploadsEnabled>("enabled");
  const initializedRef = useRef(false);
  const savedStateRef = useRef<AgentSettingsState>({
    selectedApiKeyId: "",
    defaultModel: "",
    defaultAgentId: "",
  });
  const savedSecurityStateRef = useRef({
    toolPolicy: "permissive" as GlobalToolPolicy,
    fileUploads: "enabled" as FileUploadsEnabled,
  });

  const { data: allModels, isPending: modelsLoading } = useChatModels({
    apiKeyId: selectedApiKeyId || undefined,
  });

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
    savedStateRef.current = state;
    savedSecurityStateRef.current = {
      toolPolicy: organization.globalToolPolicy ?? "permissive",
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
    fileUploads !== savedSecurityStateRef.current.fileUploads;

  const handleSave = async () => {
    if (!apiKeys) return;

    if (changes.hasChanges) {
      const payload = buildSavePayload(
        localState,
        savedStateRef.current,
        apiKeys,
      );
      await updateAgentMutation.mutateAsync(payload);
      savedStateRef.current = { ...localState };
    }

    if (securityHasChanges) {
      await updateSecurityMutation.mutateAsync({
        globalToolPolicy: toolPolicy,
        allowChatFileUploads: fileUploads === "enabled",
      });
      savedSecurityStateRef.current = { toolPolicy, fileUploads };
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
  };

  const modelItems = useMemo(() => {
    if (!allModels) return [];
    return allModels.map((model) => ({
      value: model.id,
      model: model.displayName ?? model.id,
      provider: model.provider,
    }));
  }, [allModels]);

  const selectedApiKey = useMemo(
    () => availableKeys.find((key) => key.id === selectedApiKeyId) ?? null,
    [availableKeys, selectedApiKeyId],
  );

  const agentItems = useMemo(() => {
    const items = [{ value: "__personal__", label: "User's personal agent" }];
    for (const agent of orgAgents ?? []) {
      items.push({
        value: agent.id,
        label: agent.icon ? `${agent.icon} ${agent.name}` : agent.name,
      });
    }
    return items;
  }, [orgAgents]);

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
        title="Default model for agents and new chats"
        description="Select the LLM provider API key and model that will be used by default when creating new agents and starting new chat conversations."
        control={
          <WithPermissions
            permissions={{ agentSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <div className="flex flex-col gap-2 w-80">
                <Select
                  value={selectedApiKeyId}
                  onValueChange={(value) => {
                    setSelectedApiKeyId(value);
                    setDefaultModel("");
                  }}
                  disabled={isSaving || !hasPermission}
                >
                  <SelectTrigger className="w-80">
                    <SelectValue placeholder="Select API key...">
                      {selectedApiKey ? (
                        <LlmProviderApiKeyOptionLabel
                          icon={PROVIDER_CONFIG[selectedApiKey.provider].icon}
                          providerName={
                            PROVIDER_CONFIG[selectedApiKey.provider].name
                          }
                          keyName={selectedApiKey.name}
                          secondaryLabel={`${selectedApiKey.provider} - ${selectedApiKey.scope}`}
                        />
                      ) : (
                        "Select API key..."
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <LlmProviderApiKeySelectItems
                      options={availableKeys.map((key) => ({
                        value: key.id,
                        icon: PROVIDER_CONFIG[key.provider].icon,
                        providerName: PROVIDER_CONFIG[key.provider].name,
                        keyName: key.name,
                        secondaryLabel: `${key.provider} - ${key.scope}`,
                      }))}
                    />
                  </SelectContent>
                </Select>
                <LlmModelSearchableSelect
                  value={defaultModel}
                  onValueChange={setDefaultModel}
                  options={modelItems}
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
            )}
          </WithPermissions>
        }
      />
      <SettingsBlock
        title="Default agent"
        description="The default agent is preselected for all new chat conversations. To enable agent routing, assign archestra__swap_agent to the default agent so it can swap to other agents, and archestra__swap_to_default_agent to other agents so they can swap back automatically. Only organization-scoped agents are shown."
        control={
          <WithPermissions
            permissions={{ agentSettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <SearchableSelect
                value={defaultAgentId || "__personal__"}
                onValueChange={handleAgentChange}
                placeholder="Select agent..."
                searchPlaceholder="Search agents..."
                items={agentItems}
                className="w-80"
                disabled={isSaving || !hasPermission}
                hint="Only org-wide agents are shown"
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
                href="/mcp/tool-policies"
                className="text-primary hover:underline"
              >
                Configure policies
              </Link>
            </span>
          ) : (
            <span className="text-red-600 dark:text-red-400">
              Agents can perform any action. Tool calls are allowed and results
              are trusted.
            </span>
          )
        }
      />
      <SettingsBlock
        title="Chat File Uploads"
        description="Allow users to upload files in the Archestra chat UI."
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
