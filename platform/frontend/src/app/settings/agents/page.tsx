"use client";

import { Key } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
} from "@/components/settings/settings-block";
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
} from "@/lib/organization.query";
import {
  buildSavePayload,
  detectChanges,
  resolveInitialState,
} from "./agent-settings-utils";

export default function AgentSettingsPage() {
  const { data: organization } = useOrganization();
  const { data: apiKeys } = useAvailableChatApiKeys();
  const { data: orgAgents } = useOrgScopedAgents();

  const [selectedApiKeyId, setSelectedApiKeyId] = useState<string>("");
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [defaultAgentId, setDefaultAgentId] = useState<string>("");
  const initializedRef = useRef(false);

  const { data: allModels, isPending: modelsLoading } = useChatModels({
    apiKeyId: selectedApiKeyId || null,
  });

  const updateMutation = useUpdateAgentSettings(
    "Agent settings updated",
    "Failed to update agent settings",
  );

  // Sync from org data only on initial load
  useEffect(() => {
    if (!organization || !apiKeys) return;
    if (initializedRef.current) return;

    const state = resolveInitialState(organization, apiKeys);
    setSelectedApiKeyId(state.selectedApiKeyId);
    setDefaultModel(state.defaultModel);
    setDefaultAgentId(state.defaultAgentId);
    initializedRef.current = true;
  }, [organization, apiKeys]);

  const changes = organization
    ? detectChanges(
        { selectedApiKeyId, defaultModel, defaultAgentId },
        organization,
      )
    : { hasModelChanges: false, hasAgentChanges: false, hasChanges: false };

  const handleSave = async () => {
    if (!organization || !apiKeys) return;
    const payload = buildSavePayload(
      { selectedApiKeyId, defaultModel, defaultAgentId },
      organization,
      apiKeys,
    );
    await updateMutation.mutateAsync(payload);
    // After successful save, allow re-sync from server on next org data change
    initializedRef.current = false;
  };

  const handleCancel = () => {
    if (!organization || !apiKeys) return;
    const state = resolveInitialState(organization, apiKeys);
    setSelectedApiKeyId(state.selectedApiKeyId);
    setDefaultModel(state.defaultModel);
    setDefaultAgentId(state.defaultAgentId);
  };

  const availableKeys = apiKeys ?? [];

  const modelItems = useMemo(() => {
    if (!allModels) return [];
    return allModels.map((model) => ({
      value: model.id,
      label: model.displayName ?? model.id,
    }));
  }, [allModels]);

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

  return (
    <div className="space-y-6">
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
                  disabled={updateMutation.isPending || !hasPermission}
                >
                  <SelectTrigger className="w-80">
                    <SelectValue placeholder="Select API key..." />
                  </SelectTrigger>
                  <SelectContent>
                    {availableKeys.map((key) => (
                      <SelectItem key={key.id} value={key.id}>
                        <div className="flex items-center gap-2">
                          <Key className="h-3 w-3" />
                          <span>{key.name}</span>
                          <span className="text-xs text-muted-foreground">
                            ({key.scope})
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedApiKeyId && (
                  <SearchableSelect
                    value={defaultModel}
                    onValueChange={setDefaultModel}
                    placeholder={
                      modelsLoading ? "Loading models..." : "Select model..."
                    }
                    searchPlaceholder="Search or type model name..."
                    items={modelItems}
                    className="w-80"
                    disabled={
                      updateMutation.isPending ||
                      !hasPermission ||
                      modelsLoading
                    }
                  />
                )}
              </div>
            )}
          </WithPermissions>
        }
      />
      <SettingsBlock
        title="Default agent"
        description="Select the default org-wide agent for new chat conversations. When set, this agent is preselected for all users unless they explicitly choose a different one. Only organization-scoped agents are available."
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
                disabled={updateMutation.isPending || !hasPermission}
                hint="Only org-wide agents are shown"
              />
            )}
          </WithPermissions>
        }
      />
      <SettingsSaveBar
        hasChanges={changes.hasChanges}
        isSaving={updateMutation.isPending}
        permissions={{ agentSettings: ["update"] }}
        onSave={handleSave}
        onCancel={handleCancel}
      />
    </div>
  );
}
