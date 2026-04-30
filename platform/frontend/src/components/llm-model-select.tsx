"use client";

import type { PopoverContentProps } from "@radix-ui/react-popover";
import { providerDisplayNames, type SupportedProvider } from "@shared";
import Image from "next/image";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { cn } from "@/lib/utils";

const PROVIDER_LOGO_NAME: Record<SupportedProvider, string> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "google",
  bedrock: "amazon-bedrock",
  cerebras: "cerebras",
  cohere: "cohere",
  mistral: "mistral",
  perplexity: "perplexity",
  groq: "groq",
  xai: "xai",
  openrouter: "openrouter",
  vllm: "vllm",
  ollama: "ollama-cloud",
  zhipuai: "zhipuai",
  deepseek: "deepseek",
  minimax: "minimax",
  azure: "azure",
};

export type LlmModelSelectOption = {
  value: string;
  model: string;
  provider: SupportedProvider;
  description?: string;
  pricePerMillionInput?: string | null;
  pricePerMillionOutput?: string | null;
  badge?: ReactNode;
};

export function LlmModelOptionLabel({
  option,
  showPricing = false,
  truncateModelName = true,
}: {
  option: LlmModelSelectOption;
  showPricing?: boolean;
  truncateModelName?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Image
        src={`https://models.dev/logos/${PROVIDER_LOGO_NAME[option.provider]}.svg`}
        alt={providerDisplayNames[option.provider]}
        width={16}
        height={16}
        className="shrink-0 rounded dark:invert"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              truncateModelName ? "truncate" : "whitespace-normal break-words",
            )}
          >
            {option.model}
          </span>
          {option.badge && (
            <Badge variant="outline" className="shrink-0 text-xs">
              {option.badge}
            </Badge>
          )}
        </div>
        {showPricing && (
          <div className="truncate text-xs text-muted-foreground">
            {formatPricing(option)}
          </div>
        )}
        {!showPricing && option.description && (
          <div className="truncate text-xs text-muted-foreground">
            {option.description}
          </div>
        )}
      </div>
    </div>
  );
}

function LlmModelSelectedValue({
  option,
  showPricing = false,
}: {
  option: LlmModelSelectOption;
  showPricing?: boolean;
}) {
  if (!showPricing) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <Image
          src={`https://models.dev/logos/${PROVIDER_LOGO_NAME[option.provider]}.svg`}
          alt={providerDisplayNames[option.provider]}
          width={16}
          height={16}
          className="shrink-0 rounded dark:invert"
        />
        <span className="truncate">{option.model}</span>
        {option.badge && (
          <Badge variant="outline" className="shrink-0 text-xs">
            {option.badge}
          </Badge>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2 py-0.5">
      <Image
        src={`https://models.dev/logos/${PROVIDER_LOGO_NAME[option.provider]}.svg`}
        alt={providerDisplayNames[option.provider]}
        width={16}
        height={16}
        className="shrink-0 rounded dark:invert"
      />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="truncate">{option.model}</span>
          {option.badge && (
            <Badge variant="outline" className="shrink-0 text-xs">
              {option.badge}
            </Badge>
          )}
        </div>
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
  includeAllOption = false,
  allLabel = "All models",
  searchPlaceholder = "Search models...",
  allowCustom = false,
  emptyMessage,
  popoverContentClassName,
  popoverListClassName,
  truncateOptionLabels = true,
  popoverSide,
  popoverAlign,
  popoverAvoidCollisions,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: LlmModelSelectOption[];
  placeholder?: string;
  className?: string;
  showPricing?: boolean;
  disabled?: boolean;
  includeAllOption?: boolean;
  allLabel?: string;
  searchPlaceholder?: string;
  allowCustom?: boolean;
  emptyMessage?: string;
  popoverContentClassName?: string;
  popoverListClassName?: string;
  truncateOptionLabels?: boolean;
  popoverSide?: PopoverContentProps["side"];
  popoverAlign?: PopoverContentProps["align"];
  popoverAvoidCollisions?: PopoverContentProps["avoidCollisions"];
}) {
  return (
    <SearchableSelect
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      disabled={disabled}
      className={cn("w-full", className)}
      multiline={showPricing}
      allowCustom={allowCustom}
      emptyMessage={emptyMessage}
      contentClassName={popoverContentClassName}
      listClassName={popoverListClassName}
      contentSide={popoverSide}
      contentAlign={popoverAlign}
      contentAvoidCollisions={popoverAvoidCollisions}
      items={[
        ...(includeAllOption
          ? [{ value: "all", label: allLabel, searchText: allLabel }]
          : []),
        ...options.map((option) => ({
          value: option.value,
          label: option.model,
          searchText: `${providerDisplayNames[option.provider]} ${option.model}`,
          description: option.description,
          content: (
            <LlmModelOptionLabel
              option={option}
              showPricing={showPricing}
              truncateModelName={truncateOptionLabels}
            />
          ),
          selectedContent: (
            <LlmModelSelectedValue option={option} showPricing={showPricing} />
          ),
        })),
      ]}
    />
  );
}

function formatPricing(option: LlmModelSelectOption) {
  const input = option.pricePerMillionInput ?? "0";
  const output = option.pricePerMillionOutput ?? "0";
  return `$${input} / $${output} per 1M tokens`;
}
