"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LlmModelSearchableSelect } from "@/components/llm-model-select";
import { PROVIDER_CONFIG } from "@/components/llm-provider-api-key-form";
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
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLlmModels } from "@/lib/llm-models.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import {
  useOrganization,
  useUpdateMemorySettings,
} from "@/lib/organization.query";
import {
  buildSavePayload,
  detectChanges,
  type MemorySettingsState,
  resolveInitialState,
} from "./memory-settings-utils";

export function MemorySettings() {
  const { data: organization } = useOrganization();
  const { data: apiKeys } = useAvailableLlmProviderApiKeys();
  const [state, setState] = useState<MemorySettingsState | null>(null);
  const initializedRef = useRef(false);
  const savedStateRef = useRef<MemorySettingsState | null>(null);

  const updateMemorySettings = useUpdateMemorySettings(
    "Memory settings updated",
    "Failed to update memory settings",
  );

  const { data: models } = useLlmModels({
    apiKeyId: state?.memoryExtractorChatApiKeyId || undefined,
  });

  useEffect(() => {
    if (!organization || initializedRef.current) return;
    const initial = resolveInitialState(organization);
    setState(initial);
    savedStateRef.current = initial;
    initializedRef.current = true;
  }, [organization]);

  const selectedApiKey = useMemo(
    () =>
      (apiKeys ?? []).find(
        (key) => key.id === state?.memoryExtractorChatApiKeyId,
      ) ?? null,
    [apiKeys, state?.memoryExtractorChatApiKeyId],
  );

  const modelOptions = useMemo(
    () =>
      (models ?? []).map((model) => ({
        value: model.id,
        model: model.displayName ?? model.id,
        provider: model.provider,
      })),
    [models],
  );

  if (!state || !savedStateRef.current) {
    return null;
  }

  const hasChanges = detectChanges(state, savedStateRef.current);

  const handleSave = async () => {
    const payload = buildSavePayload(
      state,
      savedStateRef.current as MemorySettingsState,
    );
    await updateMemorySettings.mutateAsync(payload);
    savedStateRef.current = { ...state };
  };

  const handleCancel = () => {
    setState({ ...(savedStateRef.current as MemorySettingsState) });
  };

  const isSaving = updateMemorySettings.isPending;

  return (
    <SettingsSectionStack>
      <SettingsBlock
        title="Extractor model"
        description="Choose the provider key and model used for extraction."
        control={
          <WithPermissions
            permissions={{ memorySettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <div className="w-80 space-y-2">
                <Select
                  value={state.memoryExtractorChatApiKeyId || "__none__"}
                  onValueChange={(value) =>
                    setState((prev) =>
                      prev
                        ? {
                            ...prev,
                            memoryExtractorChatApiKeyId:
                              value === "__none__" ? "" : value,
                            memoryExtractorModel: "",
                          }
                        : prev,
                    )
                  }
                  disabled={isSaving || !hasPermission}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Extractor API key...">
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
                        "Extractor API key..."
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No API key</SelectItem>
                    <LlmProviderApiKeySelectItems
                      options={(apiKeys ?? []).map((key) => ({
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
                  value={state.memoryExtractorModel}
                  onValueChange={(value) =>
                    setState((prev) =>
                      prev ? { ...prev, memoryExtractorModel: value } : prev,
                    )
                  }
                  options={modelOptions}
                  placeholder="Extractor model..."
                  emptyMessage="No models found."
                  disabled={isSaving || !hasPermission}
                />

                <Button
                  variant="outline"
                  onClick={() =>
                    setState((prev) =>
                      prev
                        ? {
                            ...prev,
                            memoryExtractorModel: "",
                            memoryExtractorChatApiKeyId: "",
                          }
                        : prev,
                    )
                  }
                  disabled={isSaving || !hasPermission}
                >
                  Reset extractor model
                </Button>
              </div>
            )}
          </WithPermissions>
        }
      />

      <SettingsBlock
        title="Extraction behavior"
        description="Tune when extraction runs and how much work it performs."
        control={
          <WithPermissions
            permissions={{ memorySettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <div className="w-80 space-y-2">
                <ToggleField
                  label="Post-conversation extraction"
                  value={state.memoryExtractionEnabled}
                  onChange={(value) =>
                    setState((prev) =>
                      prev
                        ? {
                            ...prev,
                            memoryExtractionEnabled: value,
                          }
                        : prev,
                    )
                  }
                  disabled={isSaving || !hasPermission}
                />

                <NumberField
                  label="Idle delay before extraction (seconds)"
                  value={state.memoryIdleDelaySeconds}
                  onChange={(value) =>
                    setState((prev) =>
                      prev ? { ...prev, memoryIdleDelaySeconds: value } : prev,
                    )
                  }
                  disabled={isSaving || !hasPermission}
                />

                <NumberField
                  label="Max candidates per extraction"
                  value={state.memoryMaxCandidatesPerExtraction}
                  onChange={(value) =>
                    setState((prev) =>
                      prev
                        ? {
                            ...prev,
                            memoryMaxCandidatesPerExtraction: value,
                          }
                        : prev,
                    )
                  }
                  disabled={isSaving || !hasPermission}
                />

                <NumberField
                  label="Extractor max output tokens"
                  value={state.memoryExtractorMaxTokens}
                  onChange={(value) =>
                    setState((prev) =>
                      prev
                        ? { ...prev, memoryExtractorMaxTokens: value }
                        : prev,
                    )
                  }
                  disabled={isSaving || !hasPermission}
                />
              </div>
            )}
          </WithPermissions>
        }
      />

      <SettingsBlock
        title="Injection"
        description="Controls for prompt-time memory injection."
        control={
          <WithPermissions
            permissions={{ memorySettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <div className="w-80 space-y-2">
                <ToggleField
                  label="Prompt-time memory injection"
                  value={state.memoryInjectionEnabled}
                  onChange={(value) =>
                    setState((prev) =>
                      prev
                        ? {
                            ...prev,
                            memoryInjectionEnabled: value,
                          }
                        : prev,
                    )
                  }
                  disabled={isSaving || !hasPermission}
                />

                <NumberField
                  label="Token budget per request"
                  value={state.memoryInjectionTokenBudget}
                  onChange={(value) =>
                    setState((prev) =>
                      prev
                        ? {
                            ...prev,
                            memoryInjectionTokenBudget: value,
                          }
                        : prev,
                    )
                  }
                  disabled={isSaving || !hasPermission}
                />

                <NumberField
                  label="Top K retrieved items"
                  value={state.memoryInjectionTopK}
                  onChange={(value) =>
                    setState((prev) =>
                      prev ? { ...prev, memoryInjectionTopK: value } : prev,
                    )
                  }
                  disabled={isSaving || !hasPermission}
                />
              </div>
            )}
          </WithPermissions>
        }
      />

      <SettingsBlock
        title="Retention & Limits"
        description="Cleanup windows and limits for memory content."
        control={
          <WithPermissions
            permissions={{ memorySettings: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <div className="w-80 space-y-2">
                <NumberField
                  label="Candidate retention (days)"
                  value={state.memoryCandidateTtlDays}
                  onChange={(value) =>
                    setState((prev) =>
                      prev ? { ...prev, memoryCandidateTtlDays: value } : prev,
                    )
                  }
                  disabled={isSaving || !hasPermission}
                />
                <NumberField
                  label="Tombstone retention (days)"
                  value={state.memoryTombstoneTtlDays}
                  onChange={(value) =>
                    setState((prev) =>
                      prev ? { ...prev, memoryTombstoneTtlDays: value } : prev,
                    )
                  }
                  disabled={isSaving || !hasPermission}
                />
                <NumberField
                  label="Max content length (characters)"
                  value={state.memoryMaxContentLength}
                  onChange={(value) =>
                    setState((prev) =>
                      prev ? { ...prev, memoryMaxContentLength: value } : prev,
                    )
                  }
                  disabled={isSaving || !hasPermission}
                />
              </div>
            )}
          </WithPermissions>
        }
      />

      <SettingsSaveBar
        hasChanges={hasChanges}
        isSaving={isSaving}
        permissions={{ memorySettings: ["update"] }}
        onSave={handleSave}
        onCancel={handleCancel}
      />
    </SettingsSectionStack>
  );
}

function ToggleField(props: {
  label: string;
  value: "enabled" | "disabled";
  disabled: boolean;
  onChange: (value: "enabled" | "disabled") => void;
}) {
  return (
    <div className="space-y-1">
      <p className="text-sm text-muted-foreground">{props.label}</p>
      <Select
        value={props.value}
        onValueChange={(value) =>
          props.onChange(value as "enabled" | "disabled")
        }
        disabled={props.disabled}
      >
        <SelectTrigger className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="enabled">Enabled</SelectItem>
          <SelectItem value="disabled">Disabled</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

function NumberField(props: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <p className="text-sm text-muted-foreground">{props.label}</p>
      <Input
        type="number"
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  );
}
