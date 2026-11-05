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
  const pick = (next: string) => {
    onValueChange(next);
    setOpen(false);
  };

  const selectedPool = pools.find((pool) => pool.value === value);
  const selectedModel = models.find((model) => model.value === value);

  const byProvider = new Map<SupportedProvider | undefined, ModelOption[]>();
  for (const model of models) {
    byProvider.set(model.provider, [
      ...(byProvider.get(model.provider) ?? []),
      model,
    ]);
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
              <ModelLabel model={selectedModel} withIcon />
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
            {[...byProvider.entries()].map(([provider, group]) => (
              <CommandGroup
                key={provider ?? "models"}
                heading={<ProviderHeading provider={provider} />}
                className={STICKY_GROUP}
              >
                {group.map((model) => (
                  <ProviderModelItem
                    key={model.value}
                    model={model}
                    onSelect={() => pick(model.value)}
                  >
                    {selectedMark(model.value)}
                  </ProviderModelItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ProviderModelItem({
  model,
  onSelect,
  children,
}: {
  model: ModelOption;
  onSelect: () => void;
  children: ReactNode;
}) {
  const catalog = useModelProviderCatalog();
  return (
    <CommandItem
      value={model.value}
      // Searching a provider's name lists all of its models.
      keywords={model.provider ? [catalog.label(model.provider)] : undefined}
      onSelect={onSelect}
    >
      <ModelLabel model={model} />
      {children}
    </CommandItem>
  );
}

function ProviderHeading({
  provider,
}: {
  provider: SupportedProvider | undefined;
}) {
  const catalog = useModelProviderCatalog();
  if (!provider) return <span>Models</span>;
  return (
    <span className="flex items-center gap-1.5">
      <ProviderIcon provider={provider} size={14} />
      <span>{catalog.label(provider)}</span>
    </span>
  );
}

function ModelLabel({
  model,
  withIcon = false,
}: {
  model: ModelOption;
  withIcon?: boolean;
}) {
  const catalog = useModelProviderCatalog();
  const name = model.modelId ?? model.value;
  if (!withIcon || !model.provider) {
    return <span className="block truncate">{name}</span>;
  }
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="shrink-0" title={catalog.label(model.provider)}>
        <ProviderIcon provider={model.provider} size={16} />
      </span>
      <span className="truncate">{name}</span>
    </span>
  );
}
