"use client";

import { providerDisplayNames } from "@shared";
import { useEffect, useState } from "react";
import { ModelSelector } from "@/components/chat/model-selector";
import { WithPermissions } from "@/components/roles/with-permissions";
import {
  SettingsBlock,
  SettingsSaveBar,
} from "@/components/settings/settings-block";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useInternalAgents } from "@/lib/agent.query";
import { useModelsByProvider } from "@/lib/chat-models.query";
import { useChatApiKeys } from "@/lib/chat-settings.query";
import {
  useOrganization,
  useUpdateAgentSettings,
} from "@/lib/organization.query";

export default function AgentSettingsPage() {
  const { data: organization } = useOrganization();
  const { data: chatApiKeys } = useChatApiKeys();
  const { data: internalAgents } = useInternalAgents();

  const [selectedApiKeyId, setSelectedApiKeyId] = useState<string>("");
  const [defaultModel, setDefaultModel] = useState<string>("");
  const [defaultAgentId, setDefaultAgentId] = useState<string>("");

  const { modelsByProvider } = useModelsByProvider({
    apiKeyId: selectedApiKeyId || null,
  });

  const updateMutation = useUpdateAgentSettings(
    "Agent settings updated",
    "Failed to update agent settings",
  );

  // Sync from org data
  useEffect(() => {
    if (!organization || !chatApiKeys) return;
    setDefaultModel(organization.defaultLlmModel ?? "");
    setDefaultAgentId(organization.defaultAgentId ?? "");

    // Resolve API key from the stored provider
    if (organization.defaultLlmProvider) {
      const matchingKey = chatApiKeys.find(
        (k) => k.provider === organization.defaultLlmProvider,
      );
      if (matchingKey) {
        setSelectedApiKeyId(matchingKey.id);
      }
    }
  }, [organization, chatApiKeys]);

  const serverModel = organization?.defaultLlmModel ?? "";
  const serverAgentId = organization?.defaultAgentId ?? "";

  const hasModelChanges = defaultModel !== serverModel;
  const hasAgentChanges = defaultAgentId !== serverAgentId;
  const hasChanges = hasModelChanges || hasAgentChanges;

  const handleSave = async () => {
    const mutations: Promise<unknown>[] = [];

    if (hasModelChanges) {
      let resolvedProvider: string | null = null;
      if (defaultModel) {
        for (const [provider, models] of Object.entries(modelsByProvider)) {
          if (models?.some((m) => m.id === defaultModel)) {
            resolvedProvider = provider;
            break;
          }
        }
      }
      mutations.push(
        updateMutation.mutateAsync({
          defaultLlmModel: defaultModel || null,
          defaultLlmProvider: resolvedProvider,
        }),
      );
    }

    if (hasAgentChanges) {
      mutations.push(
        updateMutation.mutateAsync({
          defaultAgentId: defaultAgentId || null,
        }),
      );
    }

    await Promise.allSettled(mutations);
  };

  const handleCancel = () => {
    setDefaultModel(serverModel);
    setDefaultAgentId(serverAgentId);
    if (organization?.defaultLlmProvider && chatApiKeys) {
      const matchingKey = chatApiKeys.find(
        (k) => k.provider === organization.defaultLlmProvider,
      );
      setSelectedApiKeyId(matchingKey?.id ?? "");
    }
  };

  // Filter API keys for the dropdown (exclude system keys, show org-wide first)
  const availableApiKeys = (chatApiKeys ?? []).filter((k) => !k.isSystem);

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
              <div className="flex flex-col gap-2 w-64">
                <Select
                  value={selectedApiKeyId}
                  onValueChange={(value) => {
                    setSelectedApiKeyId(value);
                    // Clear model when switching API key since models may differ
                    setDefaultModel("");
                  }}
                  disabled={updateMutation.isPending || !hasPermission}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select API key..." />
                  </SelectTrigger>
                  <SelectContent>
                    {availableApiKeys.map((key) => (
                      <SelectItem key={key.id} value={key.id}>
                        {key.name} ({providerDisplayNames[key.provider]})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedApiKeyId && (
                  <ModelSelector
                    selectedModel={defaultModel}
                    onModelChange={setDefaultModel}
                    onClear={() => setDefaultModel("")}
                    variant="outline"
                    disabled={updateMutation.isPending || !hasPermission}
                    apiKeyId={selectedApiKeyId}
                  />
                )}
              </div>
            )}
          </WithPermissions>
        }
      />
      <SettingsBlock
        title="Default agent"
        description="Select the default agent for new chat conversations. When set, this agent is preselected for all users who haven't chosen a personal default."
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
                <SelectTrigger className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__personal__">
                    User&apos;s personal agent
                  </SelectItem>
                  {(internalAgents ?? []).map((agent) => (
                    <SelectItem key={agent.id} value={agent.id}>
                      {agent.name}
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
