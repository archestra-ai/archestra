"use client";

import {
  E2eTestId,
  fromThinkingEffortOption,
  supportsThinkingEffort,
  type ThinkingEffortOption,
  type ThinkingEffortSetting,
  toThinkingEffortOption,
} from "@archestra/shared";
import { ChevronDownIcon } from "lucide-react";
import { memo, useMemo } from "react";
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
      value: "auto",
      label: "Auto",
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
  /** Null is auto — the model's own depth, which is what an untouched chat has. */
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
  // name, so the selected row has to be resolved before either can be applied.
  const supported = useMemo(() => {
    const model = models?.find((m) => m.dbId === selectedModel);
    return model ? supportsThinkingEffort(model.provider, model.id) : false;
  }, [models, selectedModel]);

  const current = toThinkingEffortOption(value);
  const selected = OPTIONS.find((option) => option.value === current);

  if (!supported) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label="Reasoning depth"
        data-testid={E2eTestId.ChatThinkingEffortSelector}
        className={cn(
          "inline-flex h-7 cursor-pointer items-center gap-1 rounded-full px-2",
          "text-xs font-medium whitespace-nowrap text-muted-foreground",
          "outline-none transition-colors hover:bg-muted hover:text-foreground",
          "focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "data-[state=open]:bg-muted data-[state=open]:text-foreground",
          className,
        )}
      >
        {selected?.label ?? current}
        <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuRadioGroup
          value={current}
          onValueChange={(next) =>
            onChange(fromThinkingEffortOption(next as ThinkingEffortOption))
          }
        >
          {OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
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
