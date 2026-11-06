"use client";

import { getAgentRuntimeModelCompatibility } from "@archestra/shared";
import { useMemo, useState } from "react";
import { LlmModelSearchableSelect } from "@/components/llm-model-select";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import { useLlmModels } from "@/lib/llm-models.query";
import { cn } from "@/lib/utils/tailwind";
import type { ModelSelection, RuntimeAgent } from "./runtime-agent";
import { useRuntimeCompatibleKeys } from "./use-runtime-compatible-keys";

/**
 * The canonical key picker + model picker, narrowed to the keys and models
 * EVERY given agent's runtime can run (pass one agent, or several for a
 * bulk "apply to all"). Picking a key clears the model.
 */
export function AgentModelPicker({
  agents,
  value,
  onChange,
  layout = "stack",
  disabled,
  className,
}: {
  agents: RuntimeAgent[];
  value: ModelSelection;
  onChange: (value: ModelSelection) => void;
  /** "stack": key above model. "row": side by side (needs ~480px). */
  layout?: "stack" | "row";
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const keys = useRuntimeCompatibleKeys(agents);
  const {
    data: models,
    isPending,
    isPlaceholderData,
  } = useLlmModels({ apiKeyId: value.apiKeyId ?? undefined });
  const options = useMemo(() => {
    if (!models || isPlaceholderData) return [];
    return models
      .filter((model) =>
        agents.every(
          (agent) =>
            getAgentRuntimeModelCompatibility({
              inferenceProtocol: agent.inferenceProtocol,
              runtimeCommand: agent.runtimeCommand,
              provider: model.provider,
              modelId: model.id,
              supportedEndpoints: model.capabilities?.supportedEndpoints,
            }).compatible,
        ),
      )
      .map((model) => ({
        value: model.dbId,
        model: model.displayName ?? model.id,
        modelId: model.id,
        provider: model.provider,
        isFree: model.isFree,
        isBest: model.isBest,
      }));
  }, [models, isPlaceholderData, agents]);
  const pending = !!value.apiKeyId && (isPending || isPlaceholderData);

  return (
    <div
      className={cn(
        layout === "row" ? "grid grid-cols-2 gap-2" : "flex flex-col gap-2",
        className,
      )}
    >
      <LlmProviderApiKeyDropdown
        availableKeys={keys}
        selectedApiKeyId={value.apiKeyId}
        disabled={disabled}
        open={open}
        onOpenChange={setOpen}
        onSelectKey={(apiKeyId) => {
          onChange({ apiKeyId, modelId: null });
          setOpen(false);
        }}
        triggerVariant="select"
        triggerClassName="w-full"
        popoverClassName="w-80"
        emptyTriggerLabel="Select provider key..."
      />
      <LlmModelSearchableSelect
        value={value.modelId ?? ""}
        onValueChange={(modelId) => onChange({ ...value, modelId })}
        options={options}
        placeholder={
          !value.apiKeyId
            ? "Select provider key first..."
            : pending
              ? "Loading models..."
              : "Select model..."
        }
        className="w-full"
        disabled={disabled || !value.apiKeyId || pending}
      />
    </div>
  );
}
