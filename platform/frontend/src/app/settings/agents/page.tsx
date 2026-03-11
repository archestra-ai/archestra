"use client";

import { Key } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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

export default function AgentSettingsPage() {
  const { data: organization } = useOrganization();
  const { data: apiKeys } = useAvailableChatApiKeys();
  const { data: orgAgents } = useOrgScopedAgents();

  const [selectedApiKeyId, setSelectedApiKeyId] = useState<string>("");
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [defaultAgentId, setDefaultAgentId] = useState<string>("");

  const { data: allModels, isPending: modelsLoading } = useChatModels({
    apiKeyId: selectedApiKeyId || null,
  });

  const updateMutation = useUpdateAgentSettings(
    "Agent settings updated",
    "Failed to update agent settings",
  );

  // Sync from org data
  useEffect(() => {
    if (!organization || !apiKeys) return;
    setDefaultModel(organization.defaultLlmModel ?? "");
    setDefaultAgentId(organization.defaultAgentId ?? "");

    // Resolve API key from the stored provider
    if (organization.defaultLlmProvider) {
      const matchingKey = apiKeys.find(
        (k) => k.provider === organization.defaultLlmProvider,
      );
      if (matchingKey) {
        setSelectedApiKeyId(matchingKey.id);
      }
    }
  }, [organization, apiKeys]);

  const serverModel = organization?.defaultLlmModel ?? "";
  const serverAgentId = organization?.defaultAgentId ?? "";

  const hasModelChanges = defaultModel !== serverModel;
  const hasAgentChanges = defaultAgentId !== serverAgentId;
  const hasChanges = hasModelChanges || hasAgentChanges;

  const handleSave = async () => {
    const payload: Record<string, unknown> = {};

    if (hasModelChanges) {
      // Resolve provider from selected API key
      let resolvedProvider: string | null = null;
      if (defaultModel && selectedApiKeyId && apiKeys) {
        const key = apiKeys.find((k) => k.id === selectedApiKeyId);
        if (key) {
          resolvedProvider = key.provider;
        }
      }
      payload.defaultLlmModel = defaultModel || null;
      payload.defaultLlmProvider = resolvedProvider;
    }

    if (hasAgentChanges) {
      payload.defaultAgentId = defaultAgentId || null;
    }

    await updateMutation.mutateAsync(payload);
  };

  const handleCancel = () => {
    setDefaultModel(serverModel);
    setDefaultAgentId(serverAgentId);
    if (organization?.defaultLlmProvider && apiKeys) {
      const matchingKey = apiKeys.find(
        (k) => k.provider === organization.defaultLlmProvider,
      );
      setSelectedApiKeyId(matchingKey?.id ?? "");
    }
  };

  const availableKeys = apiKeys ?? [];

  const modelItems = useMemo(() => {
    if (!allModels) return [];
    return allModels.map((model) => ({
      value: model.id,
      label: model.displayName ?? model.id,
    }));
  }, [allModels]);

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
              <Select
                value={defaultAgentId || "__personal__"}
                onValueChange={(value) =>
                  setDefaultAgentId(value === "__personal__" ? "" : value)
                }
                disabled={updateMutation.isPending || !hasPermission}
              >
                <SelectTrigger className="w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__personal__">
                    User&apos;s personal agent
                  </SelectItem>
                  {(orgAgents ?? []).map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.icon ? `${agent.icon} ${agent.name}` : agent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </WithPermissions>
        }
      />
      <SettingsSaveBar
        hasChanges={hasChanges}
        isSaving={updateMutation.isPending}
        permissions={{ agentSettings: ["update"] }}
        onSave={handleSave}
        onCancel={handleCancel}
      />
    </div>
  );
}
