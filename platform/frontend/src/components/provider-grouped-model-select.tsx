"use client";

import type { SupportedProvider } from "@archestra/shared";
import { Check, ChevronsUpDown } from "lucide-react";
import { type ReactNode, useState } from "react";
import { ProviderIcon } from "@/components/provider-icon";
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
import { cn } from "@/lib/utils/tailwind";

type ModelOption = {
  value: string;
  provider?: SupportedProvider;
  /** Shown in place of `value`, which may carry a `provider:` prefix. */
  modelId?: string;
};

type PoolOption = {
  value: string;
  name: string;
  description?: ReactNode;
};

// The group's own overflow-hidden would trap the sticky heading inside it.
const STICKY_GROUP =
  "overflow-visible pt-0 [&_[cmdk-group-heading]]:sticky [&_[cmdk-group-heading]]:top-0 [&_[cmdk-group-heading]]:z-10 [&_[cmdk-group-heading]]:-mx-1 [&_[cmdk-group-heading]]:bg-popover [&_[cmdk-group-heading]]:px-3";

/**
 * A searchable model picker that lists models under sticky provider headings,
 * with model pools first.
 */
export function ProviderGroupedModelSelect({
  id,
  value,
  onValueChange,
  models,
  pools,
  disabled,
  placeholder,
}: {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  models: ModelOption[];
  pools: PoolOption[];
  disabled?: boolean;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  // One catalog for the whole list; each row subscribing would add session and
  // organization observers per model.
  const catalog = useModelProviderCatalog();
  const pick = (next: string) => {
    onValueChange(next);
    setOpen(false);
  };

  const selectedPool = pools.find((pool) => pool.value === value);
  const selectedModel = models.find((model) => model.value === value);

  const byProvider = new Map<SupportedProvider | undefined, ModelOption[]>();
  for (const model of models) {
    const group = byProvider.get(model.provider);
    if (group) group.push(model);
    else byProvider.set(model.provider, [model]);
  }

  const selectedMark = (optionValue: string) => (
    <Check
      className={cn(
        "ml-auto",
        value === optionValue ? "opacity-100" : "opacity-0",
      )}
    />
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between border-input bg-transparent font-normal shadow-xs hover:bg-transparent hover:text-foreground"
        >
          {/* Keyed by the selection so a change swaps the element rather than
              reconciling an icon beside a label's text node (facebook/react#11538). */}
          <span key={value} className="min-w-0 flex-1 text-left">
            {selectedPool ? (
              <span className="block truncate">{selectedPool.name}</span>
            ) : selectedModel ? (
              <ModelLabel
                model={selectedModel}
                providerLabel={
                  selectedModel.provider
                    ? catalog.label(selectedModel.provider)
                    : undefined
                }
              />
            ) : (
              <span className="block truncate text-muted-foreground">
                {placeholder}
              </span>
            )}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-auto min-w-(--radix-popover-trigger-width) max-w-[28rem] p-0"
      >
        {/* Opens on the current choice rather than the first row. */}
        <Command defaultValue={value}>
          <CommandInput placeholder="Search models…" />
          <CommandList
            className="max-h-80"
            // A dialog's scroll lock swallows wheel events on this portaled list.
            onWheelCapture={(event) => event.stopPropagation()}
          >
            <CommandEmpty>No models match.</CommandEmpty>
            {pools.length > 0 && (
              <CommandGroup heading="Model pools" className={STICKY_GROUP}>
                {pools.map((pool) => (
                  <CommandItem
                    key={pool.value}
                    value={pool.value}
                    keywords={[pool.name]}
                    onSelect={() => pick(pool.value)}
                  >
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate">{pool.name}</span>
                      {pool.description && (
                        <span className="truncate text-xs text-muted-foreground">
                          {pool.description}
                        </span>
                      )}
                    </div>
                    {selectedMark(pool.value)}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {[...byProvider.entries()].map(([provider, group]) => {
              const providerLabel = provider
                ? catalog.label(provider)
                : undefined;
              return (
                <CommandGroup
                  key={provider ?? "models"}
                  heading={
                    provider && providerLabel ? (
                      <span className="flex items-center gap-1.5">
                        <ProviderIcon provider={provider} size={14} />
                        <span>{providerLabel}</span>
                      </span>
                    ) : (
                      <span>Models</span>
                    )
                  }
                  className={STICKY_GROUP}
                >
                  {group.map((model) => (
                    <CommandItem
                      key={model.value}
                      value={model.value}
                      // Searching a provider's name lists all of its models.
                      keywords={providerLabel ? [providerLabel] : undefined}
                      onSelect={() => pick(model.value)}
                    >
                      <ModelLabel model={model} />
                      {selectedMark(model.value)}
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** The model id, with its provider's icon when `providerLabel` is given. */
function ModelLabel({
  model,
  providerLabel,
}: {
  model: ModelOption;
  providerLabel?: string;
}) {
  const name = model.modelId ?? model.value;
  if (!providerLabel || !model.provider) {
    return <span className="block truncate">{name}</span>;
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="shrink-0" title={providerLabel}>
        <ProviderIcon provider={model.provider} size={16} />
      </span>
      <span className="truncate">{name}</span>
    </span>
  );
}
