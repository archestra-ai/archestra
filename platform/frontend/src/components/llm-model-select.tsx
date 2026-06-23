"use client";

import {
  compareModelsForDisplay,
  isOpenRouterLatestAlias,
  OPENROUTER_AUTO_MODEL_ID,
  providerDisplayNames,
  type SupportedProvider,
} from "@archestra/shared";
import type { PopoverContentProps } from "@radix-ui/react-popover";
import { Layers, Sparkles } from "lucide-react";
import Image from "next/image";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { SearchableMultiSelect } from "@/components/searchable-multi-select";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
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
  "github-copilot": "github-copilot",
};

export type LlmModelSelectOption = {
  value: string;
  model: string;
  provider: SupportedProvider;
  /**
   * The provider's native model id (e.g. `openrouter/free`). `model` is a
   * display label and may be a friendly name, so router/badge detection and
   * ordering key off this. Falls back to `model` when omitted.
   */
  modelId?: string;
  description?: string;
  pricePerMillionInput?: string | null;
  pricePerMillionOutput?: string | null;
  badge?: ReactNode;
  /** Provider charges nothing for this model — rendered with a green "Free" badge. */
  isFree?: boolean;
  /** Provider's highest-quality ("recommended") model — sorted near the top. */
  isBest?: boolean;
};

/** The provider's native model id, used for badge detection and ordering. */
function modelIdOf(option: LlmModelSelectOption): string {
  return option.modelId ?? option.model;
}

/** Renders the Free / Latest / custom badges shared across the option views. */
function ModelBadges({ option }: { option: LlmModelSelectOption }) {
  const id = modelIdOf(option);
  // the badge tells users an alias selection auto-updates to the newest model.
  const isLatestAlias = isOpenRouterLatestAlias(option.provider, id);
  return (
    <>
      {option.isFree && (
        <Badge
          variant="outline"
          className="shrink-0 gap-1 text-xs border-green-300 bg-green-100 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-300"
        >
          <Sparkles className="h-3 w-3" />
          Free
        </Badge>
      )}
      {isLatestAlias && (
        <Badge variant="outline" className="shrink-0 text-xs">
          Latest
        </Badge>
      )}
      {option.badge && (
        <Badge variant="outline" className="shrink-0 text-xs">
          {option.badge}
        </Badge>
      )}
    </>
  );
}

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
      <div className="min-w-0 flex-1 flex flex-col">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              truncateModelName ? "truncate" : "whitespace-normal break-words",
            )}
          >
            {option.model}
          </span>
          <ModelBadges option={option} />
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
        <ModelBadges option={option} />
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
          <ModelBadges option={option} />
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

function LlmModelSelectedBadge({ option }: { option: LlmModelSelectOption }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Image
        src={`https://models.dev/logos/${PROVIDER_LOGO_NAME[option.provider]}.svg`}
        alt={providerDisplayNames[option.provider]}
        width={14}
        height={14}
        className="shrink-0 rounded dark:invert"
      />
      <span className="truncate">{option.model}</span>
    </div>
  );
}

type SharedProps = {
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
  /** Show a "Free only" toggle that filters the list to zero-cost models. */
  freeFilterable?: boolean;
  /**
   * Keep the incoming option order instead of applying the shared model
   * ordering. Used when the caller imposes its own order (e.g. by price).
   */
  preserveOrder?: boolean;
};

type SingleSelectProps = SharedProps & {
  multiple?: false;
  value: string;
  onValueChange: (value: string) => void;
};

type MultiSelectProps = SharedProps & {
  multiple: true;
  value: string[];
  onValueChange: (value: string[]) => void;
  maxSelected?: number;
  maxBadgeDisplay?: number;
};

export type LlmModelSearchableSelectProps =
  | SingleSelectProps
  | MultiSelectProps;

export function LlmModelSearchableSelect(props: LlmModelSearchableSelectProps) {
  const {
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
    freeFilterable = false,
    preserveOrder = false,
  } = props;

  const [freeOnly, setFreeOnly] = useState(false);
  // drop a stale free-only filter when the caller hides the toggle, so it
  // does not silently re-apply once the toggle becomes available again.
  useEffect(() => {
    if (!freeFilterable && freeOnly) {
      setFreeOnly(false);
    }
  }, [freeFilterable, freeOnly]);
  // Shared ordering: routers, then recommended models, then the rest
  // alphabetically — identical across every model picker, unless the caller
  // imposes its own order (preserveOrder).
  const visibleOptions = useMemo(() => {
    const filtered =
      freeFilterable && freeOnly
        ? options.filter((option) => option.isFree)
        : options;
    if (preserveOrder) {
      return filtered;
    }
    return [...filtered].sort((a, b) =>
      compareModelsForDisplay(
        { modelId: modelIdOf(a), isBest: a.isBest },
        { modelId: modelIdOf(b), isBest: b.isBest },
      ),
    );
  }, [options, freeFilterable, freeOnly, preserveOrder]);

  const selectElement = props.multiple ? (
    <SearchableMultiSelect
      value={props.value}
      onValueChange={props.onValueChange}
      placeholder={placeholder}
      searchPlaceholder={searchPlaceholder}
      disabled={disabled}
      className={cn("w-full", className)}
      emptyMessage={emptyMessage}
      contentClassName={popoverContentClassName}
      listClassName={popoverListClassName}
      contentSide={popoverSide}
      contentAlign={popoverAlign}
      contentAvoidCollisions={popoverAvoidCollisions}
      maxSelected={props.maxSelected}
      maxBadgeDisplay={props.maxBadgeDisplay}
      items={[
        ...(includeAllOption
          ? [
              {
                value: "all",
                label: allLabel,
                searchText: allLabel,
                content: <AllModelsOptionLabel label={allLabel} />,
                selectedContent: <AllModelsSelectedBadge label={allLabel} />,
              },
            ]
          : []),
        ...visibleOptions.map((option) => ({
          value: option.value,
          label: option.model,
          searchText: `${providerDisplayNames[option.provider]} ${option.model}`,
          content: (
            <LlmModelOptionLabel
              option={option}
              showPricing={showPricing}
              truncateModelName={truncateOptionLabels}
            />
          ),
          selectedContent: <LlmModelSelectedBadge option={option} />,
        })),
      ]}
    />
  ) : (
    <SearchableSelect
      value={props.value}
      onValueChange={props.onValueChange}
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
          ? [
              {
                value: "all",
                label: allLabel,
                searchText: allLabel,
                content: <AllModelsOptionLabel label={allLabel} />,
                selectedContent: <AllModelsSelectedBadge label={allLabel} />,
              },
            ]
          : []),
        ...visibleOptions.map((option) => ({
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

  if (!freeFilterable) {
    return selectElement;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Switch
          id="llm-model-free-only"
          checked={freeOnly}
          onCheckedChange={setFreeOnly}
          disabled={disabled}
        />
        <Label
          htmlFor="llm-model-free-only"
          className="text-xs text-muted-foreground"
        >
          Free models only
        </Label>
      </div>
      {selectElement}
    </div>
  );
}

function formatPricing(option: LlmModelSelectOption) {
  const input = option.pricePerMillionInput ?? "0";
  const output = option.pricePerMillionOutput ?? "0";
  // OpenRouter's Auto Router has no fixed price — it bills at the routed
  // model's rate. A negative price is the same "dynamic" sentinel.
  if (
    modelIdOf(option) === OPENROUTER_AUTO_MODEL_ID ||
    Number(input) < 0 ||
    Number(output) < 0
  ) {
    return "Dynamic pricing";
  }
  return `$${input} / $${output} per 1M tokens`;
}

function AllModelsOptionLabel({ label }: { label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Layers className="shrink-0 h-4 w-4 text-muted-foreground" />
      <div className="min-w-0 flex-1 flex flex-col">
        <span className="truncate">{label}</span>
      </div>
    </div>
  );
}

function AllModelsSelectedBadge({ label }: { label: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Layers className="shrink-0 h-3.5 w-3.5 text-muted-foreground" />
      <span className="truncate">{label}</span>
    </div>
  );
}
