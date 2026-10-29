"use client";

import {
  LlmModelSearchableSelect,
  type LlmModelSelectOption,
} from "@/components/llm-model-select";
import { Label } from "@/components/ui/label";
import { type LlmModel, useLlmModels } from "@/lib/llm-models.query";

type ModelTier = "fast" | "smart";

/** Fast/smart model ids (models.id) of a trio; null falls back to the default. */
export type ModelTierSelection = Record<ModelTier, string | null>;

export const EMPTY_MODEL_TIERS: ModelTierSelection = {
  fast: null,
  smart: null,
};

const TIERS: ModelTier[] = ["fast", "smart"];
const TIER_LABELS: Record<ModelTier, string> = {
  fast: "Fast model",
  smart: "Smart model",
};
// LlmModelSearchableSelect's value for its includeAllOption entry.
const UNSET = "all";

/**
 * Fast and Smart model pickers of the organization trio: the models a forked
 * subagent runs on when its parent asks for a faster or smarter tier, and the
 * tiers auto routing chooses between. Each tier may be on any provider; an
 * unset tier falls back to the parent provider's default.
 */
export function ModelTierPickers({
  value,
  onChange,
  disabled = false,
}: {
  value: ModelTierSelection;
  onChange: (value: ModelTierSelection) => void;
  disabled?: boolean;
}) {
  const { data, isPending } = useLlmModels();
  const models = data ?? [];
  const candidates = models.filter(
    (model) => model.capabilities?.supportsToolCalling !== false,
  );

  return (
    <div className="flex flex-col gap-2">
      {TIERS.map((tier) => (
        <div key={tier} className="flex min-w-0 flex-col gap-1">
          <Label className="text-xs text-muted-foreground">
            {TIER_LABELS[tier]}
          </Label>
          <LlmModelSearchableSelect
            value={isPending ? "" : (value[tier] ?? UNSET)}
            onValueChange={(next) =>
              onChange({ ...value, [tier]: next === UNSET ? null : next })
            }
            options={tierOptions({
              candidates,
              models,
              selected: value[tier],
            })}
            includeAllOption
            allLabel="Provider default"
            placeholder="Loading models..."
            className="w-full"
            disabled={disabled || isPending}
          />
        </div>
      ))}
    </div>
  );
}

function toOption(model: LlmModel): LlmModelSelectOption {
  return {
    value: model.dbId,
    model: model.displayName ?? model.id,
    modelId: model.id,
    provider: model.provider,
    isBest: model.isBest,
  };
}

// A saved model that is no longer a valid tier choice stays listed (and
// selected) so it can be seen and cleared rather than silently hidden.
function tierOptions(params: {
  candidates: LlmModel[];
  models: LlmModel[];
  selected: string | null;
}): LlmModelSelectOption[] {
  const { candidates, models, selected } = params;
  const options = candidates.map(toOption);
  if (!selected || candidates.some((model) => model.dbId === selected)) {
    return options;
  }
  const saved = models.find((model) => model.dbId === selected);
  return saved
    ? [...options, { ...toOption(saved), badge: "No tool calling" }]
    : options;
}
