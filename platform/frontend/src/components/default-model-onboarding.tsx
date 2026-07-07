"use client";

import { E2eTestId } from "@archestra/shared";
import { useEffect, useMemo, useState } from "react";
import { FormDialog } from "@/components/form-dialog";
import { LlmModelSearchableSelect } from "@/components/llm-model-select";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import { Button } from "@/components/ui/button";
import { DialogBody, DialogStickyFooter } from "@/components/ui/dialog";
import { useAppName } from "@/lib/hooks/use-app-name";
import { useLlmModels } from "@/lib/llm-models.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useUpdateAgentSettings } from "@/lib/organization.query";

/**
 * Second first-run onboarding step, shown right after the admin adds the org's
 * first provider key and before the chat composer opens. It sets the org
 * default model (organization.defaultModelId + defaultLlmApiKeyId).
 *
 * That org default is the first fallback every built-in background subagent —
 * chat title generation, context compaction, dual-LLM, ... — resolves to when
 * it has no model of its own. Left unset, those background calls fall through
 * to the best-available model, which can load a heavy reasoning model for a
 * throwaway task. Setting a default here closes that trap; each built-in agent
 * can still be given its own model at /agents?scope=built_in.
 *
 * Mirrors the "Add an LLM Provider Key" step: a centered card whose button
 * opens the picker dialog. Dismissing the dialog (Cancel, Esc, click-outside)
 * returns to the card — it does not leave onboarding. "Skip for now" or a
 * successful save advances to chat via onDone.
 */
export function DefaultModelOnboardingStep({ onDone }: { onDone: () => void }) {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="space-y-4 text-center">
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">Set a default model</h2>
          <p className="text-sm text-muted-foreground">
            Choose the model your agents use by default. You can change it later
            in Settings.
          </p>
        </div>
        <div className="flex flex-col items-center gap-2">
          <Button
            type="button"
            onClick={() => setDialogOpen(true)}
            data-testid={E2eTestId.OnboardingDefaultModelOpen}
          >
            Choose model
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDone}
            data-testid={E2eTestId.OnboardingDefaultModelSkip}
          >
            Skip for now
          </Button>
        </div>
      </div>
      <SetDefaultModelDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSaved={onDone}
      />
    </div>
  );
}

function SetDefaultModelDialog({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const appName = useAppName();
  const { data: availableKeys = [] } = useAvailableLlmProviderApiKeys({
    enabled: open,
  });

  const [selectedApiKeyId, setSelectedApiKeyId] = useState("");
  const [apiKeySelectorOpen, setApiKeySelectorOpen] = useState(false);
  const [defaultModel, setDefaultModel] = useState("");

  // Preselect the just-added key (the only key at first run) once it loads.
  useEffect(() => {
    if (!selectedApiKeyId && availableKeys.length > 0) {
      setSelectedApiKeyId(availableKeys[0].id);
    }
  }, [availableKeys, selectedApiKeyId]);

  const {
    data: allModels,
    isPending: modelsLoading,
    isPlaceholderData,
  } = useLlmModels({
    apiKeyId: selectedApiKeyId || undefined,
  });

  // `useLlmModels` uses `keepPreviousData`, so right after a key switch `data`
  // still holds the previous key's models (isPlaceholderData). Treat that as
  // still-loading for the new key: otherwise the admin could pick a model that
  // belongs to the old provider and save it against the new provider's key.
  const modelsPending = modelsLoading || isPlaceholderData;

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
  const canFilterFreeModels = selectedApiKey?.provider === "openrouter";

  const updateMutation = useUpdateAgentSettings(
    "Default model set",
    "Failed to set default model",
  );
  const isSaving = updateMutation.isPending;

  const handleSave = async () => {
    // The mutation resolves to null on error (it toasts rather than throwing);
    // stay open in that case so the admin can retry.
    const updated = await updateMutation.mutateAsync({
      defaultModelId: defaultModel,
      defaultLlmApiKeyId: selectedApiKeyId,
    });
    if (updated) {
      onSaved();
    }
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="small"
      title="Choose a default model"
      description={
        <>
          Pick the model {appName} uses by default for new agents, new chats,
          and background tasks like chat title generation and context
          compaction. You can give any built-in agent its own model later under{" "}
          <span className="font-medium text-foreground">Agents</span> →{" "}
          <span className="font-medium text-foreground">Built-in</span>.
        </>
      }
    >
      <DialogBody className="flex flex-col gap-3">
        <LlmProviderApiKeyDropdown
          availableKeys={availableKeys}
          selectedApiKeyId={selectedApiKeyId || null}
          disabled={isSaving}
          open={apiKeySelectorOpen}
          onOpenChange={setApiKeySelectorOpen}
          onSelectKey={(value) => {
            setSelectedApiKeyId(value);
            setDefaultModel("");
            setApiKeySelectorOpen(false);
          }}
          triggerVariant="select"
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
              : modelsPending
                ? "Loading models..."
                : "Select model..."
          }
          disabled={isSaving || modelsPending || !selectedApiKeyId}
        />
      </DialogBody>
      <DialogStickyFooter>
        <Button
          type="button"
          variant="outline"
          onClick={() => onOpenChange(false)}
          disabled={isSaving}
        >
          Cancel
        </Button>
        <Button
          type="button"
          onClick={handleSave}
          disabled={isSaving || !selectedApiKeyId || !defaultModel}
          data-testid={E2eTestId.OnboardingDefaultModelSubmit}
        >
          {isSaving ? "Saving..." : "Set default"}
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}
