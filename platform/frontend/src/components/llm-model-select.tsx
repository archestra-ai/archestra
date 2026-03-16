"use client";

import { providerDisplayNames, type SupportedProvider } from "@shared";
import Image from "next/image";
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
};

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
    <div className="flex min-w-0 items-center gap-2">
      <Image
        src={`https://models.dev/logos/${PROVIDER_LOGO_NAME[option.provider]}.svg`}
        alt={providerDisplayNames[option.provider]}
        width={16}
        height={16}
        className="shrink-0 rounded dark:invert"
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
  includeAllOption = false,
  allLabel = "All models",
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
}) {
  return (
    <SearchableSelect
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      searchPlaceholder="Search models..."
      disabled={disabled}
      className={cn("w-full", className)}
      multiline={showPricing}
      items={[
        ...(includeAllOption
          ? [{ value: "all", label: allLabel, searchText: allLabel }]
          : []),
        ...options.map((option) => ({
          value: option.value,
          label: option.model,
          searchText: `${providerDisplayNames[option.provider]} ${option.model}`,
          description: undefined,
          content: (
            <LlmModelOptionLabel option={option} showPricing={showPricing} />
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
