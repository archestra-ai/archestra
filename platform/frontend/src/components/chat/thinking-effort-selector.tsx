"use client";

import {
  E2eTestId,
  fromThinkingEffortOption,
  modelSupportsThinkingEffort,
  type ThinkingEffortOption,
  type ThinkingEffortSetting,
  toThinkingEffortOption,
} from "@archestra/shared";
import { BrainIcon } from "lucide-react";
import { memo, useMemo } from "react";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLlmModels } from "@/lib/llm-models.query";
import { cn } from "@/lib/utils";

const OPTIONS: { value: ThinkingEffortOption; label: string; hint: string }[] =
  [
    {
      value: "default",
      label: "Default",
      hint: "Let the model reason as it normally would",
    },
    {
      value: "low",
      label: "Low",
      // Deliberately not "no reasoning": on a model that cannot stop reasoning
      // this is simply the least it will do, and those tokens are still billed.
      hint: "As little reasoning as the model allows",
    },
    {
      value: "medium",
      label: "Medium",
      hint: "Some reasoning before answering",
    },
    { value: "high", label: "High", hint: "Reason as deeply as the model can" },
  ];

interface ThinkingEffortSelectorProps {
  /** The conversation's model as a `models` row id, not a provider model name. */
  selectedModel: string;
  apiKeyId?: string | null;
  /** Null is the model's own depth, which is what an untouched chat has. */
  value: ThinkingEffortSetting;
  onChange: (effort: ThinkingEffortSetting) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Reasoning depth for the models that let a caller choose one. Renders nothing
 * for every other model, so the composer is unchanged wherever the choice would
 * not reach the provider.
 */
export const ThinkingEffortSelector = memo(function ThinkingEffortSelector({
  selectedModel,
  apiKeyId,
  value,
  onChange,
  disabled = false,
  className,
}: ThinkingEffortSelectorProps) {
  const { data: models } = useLlmModels({ apiKeyId: apiKeyId ?? undefined });

  // The picker deals in row ids; the capability rules read the provider's model
  // name — and, for a self-hosted server, the row's own verdict on whether the
  // model reasons — so the selected row has to be resolved before any of it can
  // be applied.
  const supported = useMemo(() => {
    const model = models?.find((m) => m.dbId === selectedModel);
    return model
      ? modelSupportsThinkingEffort({
          provider: model.provider,
          modelId: model.id,
          supportsReasoningEffort: model.capabilities?.supportsReasoningEffort,
        })
      : false;
  }, [models, selectedModel]);

  const current = toThinkingEffortOption(value);
  const selected = OPTIONS.find((option) => option.value === current);

  if (!supported) {
    return null;
  }

  return (
    <DropdownMenu>
      {/* The toolbar's own control, not a lookalike: every selector beside it
          (agent, model) is a PromptInputButton, so height, radius, type scale
          and — the part a hand-rolled trigger always drifts on — the hover,
          focus-visible and disabled states all come from one place. The brain
          is the same glyph reasoning carries in the message stream, and it
          does the job a chevron would: nothing else in this toolbar has one. */}
      <DropdownMenuTrigger asChild>
        <PromptInputButton
          disabled={disabled}
          aria-label="Reasoning depth"
          data-testid={E2eTestId.ChatThinkingEffortSelector}
          className={cn("min-w-0", className)}
        >
          <BrainIcon />
          <span className="truncate">{selected?.label ?? current}</span>
        </PromptInputButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuRadioGroup
          value={current}
          onValueChange={(next) =>
            onChange(fromThinkingEffortOption(next as ThinkingEffortOption))
          }
        >
          {OPTIONS.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              className="items-start [&>span:first-child]:mt-[3px]"
            >
              <span className="flex flex-col gap-0.5">
                <span>{option.label}</span>
                <span className="text-xs text-muted-foreground">
                  {option.hint}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
