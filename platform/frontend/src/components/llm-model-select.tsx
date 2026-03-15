"use client";

import { providerDisplayNames, type SupportedProvider } from "@shared";
import Image from "next/image";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { cn } from "@/lib/utils";

export type LlmModelSelectOption = {
  value: string;
  model: string;
  provider: SupportedProvider;
  pricePerMillionInput?: string | null;
  pricePerMillionOutput?: string | null;
};

export function LlmModelOptionLabel({
  option,
  showPricing = false,
}: {
  option: LlmModelSelectOption;
  showPricing?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <Image
        src={`https://models.dev/logos/${option.provider}.svg`}
        alt={providerDisplayNames[option.provider]}
        width={16}
        height={16}
        className="mt-0.5 rounded dark:invert"
      />
      <div className="min-w-0">
        <div className="truncate">{option.model}</div>
        {showPricing && (
          <div className="truncate text-xs text-muted-foreground">
            {formatPricing(option)}
          </div>
        )}
      </div>
    </div>
  );
}

export function LlmModelSearchableSelect({
  value,
  onValueChange,
  options,
  placeholder = "Select model...",
  className,
  showPricing = false,
  disabled = false,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: LlmModelSelectOption[];
  placeholder?: string;
  className?: string;
  showPricing?: boolean;
  disabled?: boolean;
}) {
  return (
    <SearchableSelect
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      searchPlaceholder="Search models..."
      disabled={disabled}
      className={cn("w-full", className)}
      items={options.map((option) => ({
        value: option.value,
        label: option.model,
        searchText: `${providerDisplayNames[option.provider]} ${option.model}`,
        description: showPricing ? formatPricing(option) : providerDisplayNames[option.provider],
        content: <LlmModelOptionLabel option={option} showPricing={showPricing} />,
      }))}
    />
  );
}

function formatPricing(option: LlmModelSelectOption) {
  const input = option.pricePerMillionInput ?? "0";
  const output = option.pricePerMillionOutput ?? "0";
  return `$${input}/$${output} per 1M tok`;
}
