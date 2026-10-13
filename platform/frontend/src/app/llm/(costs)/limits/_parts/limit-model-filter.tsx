"use client";

import {
  compareModelsForDisplay,
  type SupportedProvider,
} from "@archestra/shared";
import { Check, ChevronDown, Layers } from "lucide-react";
import { useMemo, useState } from "react";
import { ModelSelectorLogo } from "@/components/ai-elements/model-selector";
import { filterControlClass } from "@/components/filter-bar";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { logoNameForProvider } from "@/lib/provider-logos";
import { cn } from "@/lib/utils/tailwind";

/**
 * The Limits model filter, laid out like the chat model picker: models
 * grouped under their provider with its logo, display names first, and how
 * many limits name each model.
 */
export function LimitModelFilter({
  value,
  onValueChange,
  models,
  limitCountByModel,
}: {
  value: string;
  onValueChange: (value: string) => void;
  models: LimitFilterModel[];
  /** Limits that name each model id. */
  limitCountByModel: Map<string, number>;
}) {
  const [open, setOpen] = useState(false);
  const providerCatalog = useModelProviderCatalog();

  const groups = useMemo(() => {
    const byProvider = new Map<SupportedProvider, LimitFilterModel[]>();
    for (const model of models) {
      const list = byProvider.get(model.provider) ?? [];
      list.push(model);
      byProvider.set(model.provider, list);
    }
    return [...byProvider.entries()]
      .map(([provider, list]) => ({
        provider,
        label: providerCatalog.label(provider),
        models: [...list].sort((a, b) =>
          compareModelsForDisplay(
            { modelId: a.modelId, isBest: a.isBest },
            { modelId: b.modelId, isBest: b.isBest },
          ),
        ),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [models, providerCatalog]);

  const selected = models.find((model) => model.modelId === value);
  const select = (next: string) => {
    onValueChange(next);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Filter by model"
          className={filterControlClass({ active: value !== "all" })}
        >
          {selected ? (
            <ModelSelectorLogo
              provider={logoNameForProvider(selected.provider)}
              className="size-3.5"
            />
          ) : (
            <Layers className="size-3.5" />
          )}
          <span className="truncate">
            {selected ? selected.displayName : "All models"}
          </span>
          <ChevronDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[22rem] max-w-[calc(100vw-2rem)] p-0"
      >
        <Command>
          <CommandInput placeholder="Search models or providers" />
          <CommandList className="max-h-80">
            <CommandEmpty>No models match.</CommandEmpty>
            <CommandGroup>
              <CommandItem value="all-models" onSelect={() => select("all")}>
                <Layers className="size-4 text-muted-foreground" />
                <span className="flex-1">All models</span>
                <SelectedCheck visible={value === "all"} />
              </CommandItem>
            </CommandGroup>
            {groups.map((group) => (
              <CommandGroup key={group.provider} heading={group.label}>
                {group.models.map((model) => {
                  const count = limitCountByModel.get(model.modelId) ?? 0;
                  return (
                    <CommandItem
                      key={`${model.provider}:${model.modelId}`}
                      value={`${model.provider}:${model.modelId}`}
                      keywords={[model.displayName, model.modelId, group.label]}
                      onSelect={() => select(model.modelId)}
                    >
                      <ModelSelectorLogo
                        provider={logoNameForProvider(model.provider)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">
                          {model.displayName}
                        </span>
                        {model.displayName !== model.modelId && (
                          <span className="block truncate font-mono text-xs text-muted-foreground">
                            {model.modelId}
                          </span>
                        )}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 text-xs tabular-nums",
                          count > 0
                            ? "text-foreground"
                            : "text-muted-foreground/60",
                        )}
                      >
                        {count === 1 ? "1 limit" : `${count} limits`}
                      </span>
                      <SelectedCheck visible={value === model.modelId} />
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export type LimitFilterModel = {
  modelId: string;
  provider: SupportedProvider;
  displayName: string;
  isBest: boolean;
};

function SelectedCheck({ visible }: { visible: boolean }) {
  return (
    <Check
      className={cn("size-4 shrink-0", visible ? "opacity-100" : "opacity-0")}
    />
  );
}
