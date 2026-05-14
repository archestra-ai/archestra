"use client";

import {
  E2eTestId,
  isOpenRouterLatestAlias,
  type ModelInputModality,
  providerDisplayNames,
  type SupportedProvider,
} from "@shared";
import {
  CheckIcon,
  CopyIcon,
  DollarSign,
  FileText,
  ImageIcon,
  Layers,
  Loader2,
  Mic,
  RefreshCw,
  Settings2,
  Video,
  XIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelector as ModelSelectorRoot,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import {
  FreeModelBadge,
  LatestModelBadge,
  UnknownCapabilitiesBadge,
} from "@/components/model-badges";
import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Toggle } from "@/components/ui/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type LlmModel,
  type ModelCapabilities,
  useAvailableLlmModel,
  useInfiniteLlmModels,
  useSyncLlmModels,
} from "@/lib/llm-models.query";
import { cn, formatContextLength } from "@/lib/utils";

/** Modalities that can be filtered (excludes "text" since all models support it) */
type FilterableModality = Exclude<ModelInputModality, "text">;

/** Filter configuration for a modality */
type ModalityFilterConfig = {
  modality: FilterableModality;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
};

/** Available modality filters */
const MODALITY_FILTERS: ModalityFilterConfig[] = [
  { modality: "image", icon: ImageIcon, label: "Vision" },
  { modality: "audio", icon: Mic, label: "Audio" },
  { modality: "video", icon: Video, label: "Video" },
  { modality: "pdf", icon: FileText, label: "PDF" },
];

/** Tool calling filter config */
const TOOL_CALLING_FILTER = {
  icon: Settings2,
  label: "Tools",
};

const PROVIDER_OPTIONS = Object.keys(
  providerDisplayNames,
) as SupportedProvider[];

const MODEL_SELECTOR_TRIGGER_CLASSNAME =
  "transition-[width,max-width,background-color,color,border-color,opacity] duration-200 ease-out";
const MODEL_SELECTOR_VALUE_CLASSNAME =
  "min-w-0 truncate transition-[opacity,color] duration-150 ease-out";

interface ModelSelectorProps {
  /** Currently selected model */
  selectedModel: string;
  /** Callback when model is changed */
  onModelChange: (model: string, modelDetails?: LlmModel | null) => void;
  /** Whether the selector should be disabled */
  disabled?: boolean;
  /** Callback when the selector opens or closes */
  onOpenChange?: (open: boolean) => void;
  /** Optional callback to clear selection - shows X button inside the trigger when provided and a model is selected */
  onClear?: () => void;
  /** Render trigger as an outline button instead of the default ghost prompt-input button */
  variant?: "default" | "outline";
  /** When provided, only show models associated with this API key */
  apiKeyId?: string | null;
  /** Whether the model query should be enabled */
  enabled?: boolean;
  /** Label shown for a disabled empty selector before falling back to the generic empty state */
  disabledEmptyLabel?: string;
  /** Whether the selected key/model pair is being resolved by the parent */
  isResolvingSelection?: boolean;
  /** Whether to load the model list and select the best/first model when no model is selected */
  autoSelectBestAvailable?: boolean;
}

/** Map our provider names to logo provider names
 * models.dev provider IDs
 * see https://github.com/anomalyco/models.dev/tree/dev/providers
 * */
export const providerToLogoProvider: Record<SupportedProvider, string> = {
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
  ollama: "ollama-cloud", // models.dev uses ollama-cloud for the Ollama provider
  zhipuai: "zhipuai",
  deepseek: "deepseek",
  minimax: "minimax",
  azure: "azure",
};

/**
 * Creates a unique value for a model that includes the provider.
 * This prevents issues when different providers have models with the same ID.
 */
function createModelValue(
  provider: SupportedProvider,
  modelId: string,
): string {
  return `${provider}:${modelId}`;
}

/**
 * Extracts the provider and model ID from a combined model value.
 */
function parseModelValue(
  value: string,
): { provider: SupportedProvider; modelId: string } | null {
  const colonIndex = value.indexOf(":");
  if (colonIndex === -1) return null;
  return {
    provider: value.substring(0, colonIndex) as SupportedProvider,
    modelId: value.substring(colonIndex + 1),
  };
}

/**
 * Capability icon component - matches Vercel AI Elements style.
 * Small, compact icons that show model capabilities.
 */
function CapabilityIcon({
  icon: Icon,
  label,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "inline-flex items-center justify-center size-4 rounded-sm bg-muted/50",
            className,
          )}
        >
          <Icon className="size-2.5 text-muted-foreground" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Displays capability icons for a model in a compact row.
 * Style inspired by Vercel AI Elements model selector.
 */
function ModelCapabilityBadges({
  capabilities,
}: {
  capabilities?: ModelCapabilities;
}) {
  const hasVision = capabilities?.inputModalities?.includes("image");
  const hasAudio = capabilities?.inputModalities?.includes("audio");
  const hasVideo = capabilities?.inputModalities?.includes("video");
  const hasPdf = capabilities?.inputModalities?.includes("pdf");
  const hasToolCalling = capabilities?.supportsToolCalling;

  const hasAnyCapability =
    hasVision || hasAudio || hasVideo || hasPdf || hasToolCalling;

  // Show "unknown" badge if no capabilities data at all
  if (!capabilities || !hasAnyCapability) {
    return <UnknownCapabilitiesBadge />;
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex items-center gap-0.5">
        {hasVision && (
          <CapabilityIcon icon={ImageIcon} label="Supports vision (images)" />
        )}
        {hasAudio && <CapabilityIcon icon={Mic} label="Supports audio input" />}
        {hasVideo && (
          <CapabilityIcon icon={Video} label="Supports video input" />
        )}
        {hasPdf && (
          <CapabilityIcon icon={FileText} label="Supports PDF input" />
        )}
        {hasToolCalling && (
          <CapabilityIcon icon={Settings2} label="Supports tool calling" />
        )}
      </div>
    </TooltipProvider>
  );
}

/**
 * Displays the context window size with a tooltip.
 */
function ContextLengthIndicator({
  contextLength,
}: {
  contextLength: number | null | undefined;
}) {
  if (!contextLength) {
    return null;
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground font-mono">
            <Layers className="size-3" />
            {formatContextLength(contextLength)}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {contextLength.toLocaleString()} token context window
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Displays pricing information with a tooltip showing cost per million tokens.
 */
function PricingIndicator({
  pricePerMillionInput,
  pricePerMillionOutput,
}: {
  pricePerMillionInput: string | null | undefined;
  pricePerMillionOutput: string | null | undefined;
}) {
  if (!pricePerMillionInput && !pricePerMillionOutput) {
    return null;
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center text-muted-foreground">
            <DollarSign className="size-3" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          <div className="flex flex-col gap-0.5">
            {pricePerMillionInput && (
              <span>Input: ${pricePerMillionInput}/M tokens</span>
            )}
            {pricePerMillionOutput && (
              <span>Output: ${pricePerMillionOutput}/M tokens</span>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Copy button for model ID that stops propagation to prevent row selection.
 */
function CopyModelIdButton({ modelId }: { modelId: string }) {
  const [copied, setCopied] = useState(false);

  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      try {
        await navigator.clipboard.writeText(modelId);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // Fallback for older browsers
        const textArea = document.createElement("textarea");
        textArea.value = modelId;
        textArea.style.position = "fixed";
        textArea.style.left = "-999999px";
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    },
    [modelId],
  );

  return (
    <button
      type="button"
      onClick={handleClick}
      onMouseDown={(e) => e.stopPropagation()}
      className="inline-flex items-center justify-center size-4 rounded hover:bg-muted/80 transition-colors ml-1 opacity-0 group-hover:opacity-100"
      aria-label={copied ? "Copied!" : "Copy model ID"}
    >
      {copied ? (
        <CheckIcon className="size-2.5 text-green-500" />
      ) : (
        <CopyIcon className="size-2.5 text-muted-foreground" />
      )}
    </button>
  );
}

/** Filter state type */
type ModelFilters = {
  provider?: SupportedProvider;
  modalities: Set<FilterableModality>;
  toolCalling: boolean;
};

/** Initial filter state - no filters active */
const INITIAL_FILTERS: ModelFilters = {
  provider: undefined,
  modalities: new Set(),
  toolCalling: false,
};

/**
 * Filter toggle button for capabilities.
 * Shows a checkmark and highlighted styling when active.
 */
function FilterToggle({
  icon: Icon,
  label,
  pressed,
  onPressedChange,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
}) {
  return (
    <Toggle
      size="sm"
      pressed={pressed}
      onPressedChange={onPressedChange}
      className={cn(
        "h-7 px-2 gap-1.5 border transition-colors",
        pressed
          ? "bg-primary text-primary-foreground border-primary ring-2 ring-primary/20"
          : "border-transparent hover:border-border",
      )}
    >
      {pressed && <CheckIcon className="size-3" />}
      <Icon className="size-3.5" />
      <span className="text-xs">{label}</span>
    </Toggle>
  );
}

/**
 * Filter bar for model capabilities.
 */
function ModelFiltersBar({
  filters,
  onFiltersChange,
  onRefresh,
  isRefreshing,
  showProviderFilter,
}: {
  filters: ModelFilters;
  onFiltersChange: (filters: ModelFilters) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  showProviderFilter: boolean;
}) {
  const handleProviderChange = useCallback(
    (value: string) => {
      onFiltersChange({
        ...filters,
        provider: value === "all" ? undefined : (value as SupportedProvider),
      });
    },
    [filters, onFiltersChange],
  );

  const toggleModality = useCallback(
    (modality: FilterableModality, pressed: boolean) => {
      const newModalities = new Set(filters.modalities);
      if (pressed) {
        newModalities.add(modality);
      } else {
        newModalities.delete(modality);
      }
      onFiltersChange({ ...filters, modalities: newModalities });
    },
    [filters, onFiltersChange],
  );

  const toggleToolCalling = useCallback(
    (pressed: boolean) => {
      onFiltersChange({ ...filters, toolCalling: pressed });
    },
    [filters, onFiltersChange],
  );

  return (
    <div className="flex items-center gap-1 px-3 py-2 border-b">
      <span className="text-xs text-muted-foreground mr-1">Filter:</span>
      <div className="flex flex-wrap items-center gap-1 flex-1">
        {showProviderFilter && (
          <Select
            value={filters.provider ?? "all"}
            onValueChange={handleProviderChange}
          >
            <SelectTrigger
              aria-label="Filter by provider"
              className="h-7 w-[150px] px-2 text-xs"
            >
              <SelectValue placeholder="Provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All providers</SelectItem>
              {PROVIDER_OPTIONS.map((provider) => (
                <SelectItem key={provider} value={provider}>
                  {providerDisplayNames[provider]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {MODALITY_FILTERS.map((config) => (
          <FilterToggle
            key={config.modality}
            icon={config.icon}
            label={config.label}
            pressed={filters.modalities.has(config.modality)}
            onPressedChange={(pressed) =>
              toggleModality(config.modality, pressed)
            }
          />
        ))}
        <FilterToggle
          icon={TOOL_CALLING_FILTER.icon}
          label={TOOL_CALLING_FILTER.label}
          pressed={filters.toolCalling}
          onPressedChange={toggleToolCalling}
        />
      </div>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onRefresh}
              disabled={isRefreshing}
              className="rounded-sm p-1 opacity-70 ring-offset-background transition-opacity hover:opacity-100 hover:bg-muted focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:opacity-50"
            >
              <RefreshCw
                className={cn("size-4", isRefreshing && "animate-spin")}
              />
              <span className="sr-only">Refresh models</span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-xs">
            Refresh models from providers
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <DialogClose className="rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
        <XIcon className="size-4" />
        <span className="sr-only">Close</span>
      </DialogClose>
    </div>
  );
}

function DebouncedModelSelectorInput({
  onDebouncedValueChange,
}: {
  onDebouncedValueChange: (value: string) => void;
}) {
  const [value, setValue] = useState("");

  useEffect(() => {
    const timeout = setTimeout(() => {
      onDebouncedValueChange(value);
    }, 250);
    return () => clearTimeout(timeout);
  }, [onDebouncedValueChange, value]);

  return (
    <ModelSelectorInput
      placeholder="Search models..."
      value={value}
      onValueChange={setValue}
      autoFocus
    />
  );
}

export const ModelSelector = memo(function ModelSelector({
  selectedModel,
  onModelChange,
  disabled = false,
  onOpenChange: onOpenChangeProp,
  onClear,
  variant = "default",
  apiKeyId,
  enabled = true,
  disabledEmptyLabel,
  isResolvingSelection = false,
  autoSelectBestAvailable = true,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<ModelFilters>(INITIAL_FILTERS);
  const [searchQuery, setSearchQuery] = useState("");
  const [loadMoreNode, setLoadMoreNode] = useState<HTMLDivElement | null>(null);
  const shouldAutoSelectBestAvailable =
    enabled !== false &&
    autoSelectBestAvailable &&
    !selectedModel &&
    !isResolvingSelection &&
    !onClear;
  const shouldFetchModelList =
    enabled !== false && (open || shouldAutoSelectBestAvailable);
  const modelListInputModalities =
    filters.modalities.size > 0 ? Array.from(filters.modalities) : undefined;

  const {
    models,
    isPending: isLoading,
    isFetching,
    isFetchingNextPage,
    isPlaceholderData,
    hasNextPage,
    fetchNextPage,
  } = useInfiniteLlmModels({
    apiKeyId: apiKeyId ?? undefined,
    provider: filters.provider,
    q: searchQuery.trim() || undefined,
    inputModalities: modelListInputModalities,
    supportsToolCalling: filters.toolCalling ? "true" : undefined,
    limit: 50,
    enabled: shouldFetchModelList,
  });
  const selectedModelQuery = useAvailableLlmModel({
    modelId: selectedModel || null,
    apiKeyId: apiKeyId ?? undefined,
    enabled,
  });
  const syncMutation = useSyncLlmModels();

  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      setOpen(newOpen);
      // Reset filters when closing the dialog
      if (!newOpen) {
        setFilters(INITIAL_FILTERS);
        setSearchQuery("");
      }
      onOpenChangeProp?.(newOpen);
    },
    [onOpenChangeProp],
  );

  const handleRefreshModels = useCallback(() => {
    syncMutation.mutate();
  }, [syncMutation]);

  const handleClearSelection = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClear?.();
    },
    [onClear],
  );

  const handleDebouncedSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
  }, []);

  const handleSelectBestAvailable = useCallback(() => {
    handleOpenChange(false);
    onClear?.();
  }, [handleOpenChange, onClear]);

  useEffect(() => {
    if (!open || !hasNextPage || isFetching || isFetchingNextPage) {
      return;
    }

    if (!loadMoreNode) {
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        fetchNextPage();
      }
    });
    observer.observe(loadMoreNode);

    return () => observer.disconnect();
  }, [
    fetchNextPage,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    loadMoreNode,
    open,
  ]);

  const modelIndexes = useMemo(() => {
    const modelById = new Map<string, LlmModel>();

    for (const model of models) {
      modelById.set(model.dbId ?? model.id, model);
    }

    return { allModels: models, modelById };
  }, [models]);

  // Check if any filters are active
  const hasActiveFilters =
    !!filters.provider || filters.modalities.size > 0 || filters.toolCalling;
  const hasSearch = searchQuery.trim().length > 0;
  const isRefreshingResults =
    open && isFetching && !isFetchingNextPage && !isLoading;
  const isQueryEnabled = enabled !== false;
  const selectedModelDetails =
    modelIndexes.modelById.get(selectedModel) ??
    selectedModelQuery.data ??
    null;

  // Get selected model's provider for logo
  const selectedModelProvider = selectedModelDetails?.provider ?? null;
  const selectedModelLogo = selectedModelProvider
    ? providerToLogoProvider[selectedModelProvider]
    : null;

  // Get display name for selected model
  const selectedModelDisplayName =
    selectedModelDetails?.displayName ?? selectedModel;

  const handleSelectModel = useCallback(
    (modelValue: string) => {
      // Parse the provider:modelId format
      const parsed = parseModelValue(modelValue);
      const modelId = parsed?.modelId ?? modelValue;

      // If selecting the same model, just close the dialog
      if (modelId === selectedModel) {
        handleOpenChange(false);
        return;
      }

      const modelDetails =
        modelIndexes.modelById.get(modelId) ??
        (selectedModel === modelId ? selectedModelQuery.data : null);
      handleOpenChange(false);
      onModelChange(modelId, modelDetails);
    },
    [
      handleOpenChange,
      modelIndexes.modelById,
      onModelChange,
      selectedModel,
      selectedModelQuery.data,
    ],
  );

  const isSelectedModelLoadedInList = modelIndexes.modelById.has(selectedModel);
  const isSelectedModelMissingFromApiKey =
    !!selectedModel &&
    !isResolvingSelection &&
    !isSelectedModelLoadedInList &&
    selectedModelQuery.isFetched &&
    !selectedModelQuery.isFetching &&
    !selectedModelQuery.data;
  const showClearButton = Boolean(onClear && selectedModel);

  // Auto-select the best loaded model when the parent has no explicit model.
  useEffect(() => {
    if (!shouldAutoSelectBestAvailable) return;
    if (isLoading || modelIndexes.allModels.length === 0) return;
    const modelToSelect =
      modelIndexes.allModels.find((model) => model.isBest) ??
      modelIndexes.allModels[0];
    if (modelToSelect) {
      onModelChange(modelToSelect.dbId ?? modelToSelect.id, modelToSelect);
    }
  }, [
    isLoading,
    modelIndexes.allModels,
    onModelChange,
    shouldAutoSelectBestAvailable,
  ]);

  // If loading, show loading state
  if (shouldFetchModelList && isLoading && !open) {
    return (
      <PromptInputButton className={MODEL_SELECTOR_TRIGGER_CLASSNAME} disabled>
        <Loader2 className="size-4 animate-spin" />
        <ModelSelectorName className={MODEL_SELECTOR_VALUE_CLASSNAME}>
          Loading models...
        </ModelSelectorName>
      </PromptInputButton>
    );
  }

  if (
    !isQueryEnabled &&
    disabledEmptyLabel &&
    !open &&
    !selectedModel &&
    !hasActiveFilters &&
    !hasSearch
  ) {
    if (variant === "outline") {
      return (
        <Button
          variant="outline"
          size="sm"
          disabled
          className={cn(
            "h-8 px-3 gap-1.5 text-xs w-full",
            MODEL_SELECTOR_TRIGGER_CLASSNAME,
          )}
          data-testid={E2eTestId.ChatModelSelectorTrigger}
        >
          <span
            className={cn(
              "text-muted-foreground",
              MODEL_SELECTOR_VALUE_CLASSNAME,
            )}
          >
            {disabledEmptyLabel}
          </span>
        </Button>
      );
    }

    return (
      <PromptInputButton className={MODEL_SELECTOR_TRIGGER_CLASSNAME} disabled>
        <ModelSelectorName
          className={cn(
            "text-muted-foreground",
            MODEL_SELECTOR_VALUE_CLASSNAME,
          )}
        >
          {disabledEmptyLabel}
        </ModelSelectorName>
      </PromptInputButton>
    );
  }

  // If no providers configured, show disabled state
  if (
    !open &&
    !selectedModel &&
    !hasActiveFilters &&
    !hasSearch &&
    (enabled === false || (shouldFetchModelList && !isLoading)) &&
    models.length === 0
  ) {
    return (
      <PromptInputButton className={MODEL_SELECTOR_TRIGGER_CLASSNAME} disabled>
        <ModelSelectorName className={MODEL_SELECTOR_VALUE_CLASSNAME}>
          No models available
        </ModelSelectorName>
      </PromptInputButton>
    );
  }

  return (
    <ModelSelectorRoot open={open} onOpenChange={handleOpenChange}>
      <div className="relative inline-flex">
        <ModelSelectorTrigger asChild>
          {variant === "outline" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || isResolvingSelection}
              className={cn(
                "h-8 px-3 gap-1.5 text-xs w-full",
                MODEL_SELECTOR_TRIGGER_CLASSNAME,
                showClearButton && "pr-8",
              )}
              data-testid={E2eTestId.ChatModelSelectorTrigger}
            >
              {selectedModelLogo && (
                <ModelSelectorLogo
                  provider={selectedModelLogo}
                  className="shrink-0"
                />
              )}
              {selectedModelDisplayName ? (
                <span
                  className={cn("font-medium", MODEL_SELECTOR_VALUE_CLASSNAME)}
                >
                  {selectedModelDisplayName}
                </span>
              ) : (
                <span
                  className={cn(
                    "text-muted-foreground",
                    MODEL_SELECTOR_VALUE_CLASSNAME,
                  )}
                >
                  Best available model
                </span>
              )}
            </Button>
          ) : (
            <PromptInputButton
              disabled={disabled || isResolvingSelection}
              className={cn(
                MODEL_SELECTOR_TRIGGER_CLASSNAME,
                showClearButton && "pr-8",
              )}
              data-testid={E2eTestId.ChatModelSelectorTrigger}
            >
              {selectedModelLogo && (
                <ModelSelectorLogo
                  provider={selectedModelLogo}
                  className="shrink-0"
                />
              )}
              <ModelSelectorName className={MODEL_SELECTOR_VALUE_CLASSNAME}>
                {selectedModelDisplayName || "Select model"}
              </ModelSelectorName>
            </PromptInputButton>
          )}
        </ModelSelectorTrigger>
        {showClearButton && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Clear model"
            disabled={disabled || isResolvingSelection}
            className="absolute right-1 top-1/2 size-6 -translate-y-1/2 opacity-50 hover:opacity-100"
            onClick={handleClearSelection}
          >
            <XIcon className="size-3" />
          </Button>
        )}
      </div>
      {open && (
        <ModelSelectorContent
          title="Select Model"
          onCloseAutoFocus={(e) => e.preventDefault()}
          showCloseButton={false}
          shouldFilter={false}
        >
          <ModelFiltersBar
            filters={filters}
            onFiltersChange={setFilters}
            onRefresh={handleRefreshModels}
            isRefreshing={syncMutation.isPending}
            showProviderFilter={!apiKeyId}
          />
          <DebouncedModelSelectorInput
            onDebouncedValueChange={handleDebouncedSearchChange}
          />
          <ModelSelectorList className="relative">
            {isRefreshingResults && (
              <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
                <div className="flex items-center gap-2 rounded-md border bg-background/95 px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
                  <Loader2 className="size-3 animate-spin" />
                  Updating results...
                </div>
              </div>
            )}
            <ModelSelectorEmpty>
              {hasActiveFilters || hasSearch
                ? "No models match the selected filters."
                : "No models found."}
            </ModelSelectorEmpty>

            {/* Option to unselect model */}
            {onClear && (
              <ModelSelectorGroup heading="">
                <ModelSelectorItem
                  value="__none__"
                  onSelect={handleSelectBestAvailable}
                >
                  <ModelSelectorName>
                    Best available model (resolved at runtime)
                  </ModelSelectorName>
                  {!selectedModel && <CheckIcon className="ml-auto size-4" />}
                </ModelSelectorItem>
              </ModelSelectorGroup>
            )}

            {selectedModel && (
              <ModelSelectorGroup
                heading={
                  isSelectedModelMissingFromApiKey
                    ? "Current (API key missing)"
                    : "Current"
                }
              >
                <ModelSelectorItem
                  disabled
                  value={selectedModel}
                  className={cn(
                    isSelectedModelMissingFromApiKey && "text-yellow-600",
                  )}
                >
                  {selectedModelLogo && (
                    <ModelSelectorLogo provider={selectedModelLogo} />
                  )}
                  <ModelSelectorName>
                    {selectedModelDisplayName}
                  </ModelSelectorName>
                  <CheckIcon className="ml-auto size-4" />
                </ModelSelectorItem>
              </ModelSelectorGroup>
            )}

            <ModelSelectorGroup heading="">
              {models.map((model) => {
                const selectionId = model.dbId ?? model.id;
                const modelValue = createModelValue(
                  model.provider,
                  selectionId,
                );
                return (
                  <ModelSelectorItem
                    key={modelValue}
                    value={modelValue}
                    keywords={[
                      model.displayName,
                      model.id,
                      providerDisplayNames[model.provider],
                    ]}
                    onSelect={() => handleSelectModel(modelValue)}
                    className="group"
                  >
                    <ModelSelectorLogo
                      provider={providerToLogoProvider[model.provider]}
                    />
                    <ModelSelectorName>
                      <span>{model.displayName}</span>{" "}
                      <span className="text-xs text-muted-foreground">
                        {providerDisplayNames[model.provider]}
                      </span>{" "}
                      <span className="text-xs text-muted-foreground font-mono">
                        ({model.id})
                      </span>
                      <CopyModelIdButton modelId={model.id} />
                    </ModelSelectorName>
                    {model.isFree && <FreeModelBadge />}
                    {isOpenRouterLatestAlias(model.provider, model.id) && (
                      <LatestModelBadge />
                    )}
                    <div className="ml-auto flex items-center gap-2">
                      <ModelCapabilityBadges
                        capabilities={model.capabilities}
                      />
                      <ContextLengthIndicator
                        contextLength={model.capabilities?.contextLength}
                      />
                      <PricingIndicator
                        pricePerMillionInput={
                          model.capabilities?.pricePerMillionInput
                        }
                        pricePerMillionOutput={
                          model.capabilities?.pricePerMillionOutput
                        }
                      />
                      {selectedModel === selectionId ? (
                        <CheckIcon className="size-4" />
                      ) : (
                        <div className="size-4" />
                      )}
                    </div>
                  </ModelSelectorItem>
                );
              })}
            </ModelSelectorGroup>
            <div ref={setLoadMoreNode} className="py-2 text-center text-xs">
              {isFetchingNextPage && (
                <span className="text-muted-foreground">Loading more...</span>
              )}
              {!hasNextPage && models.length > 0 && !isPlaceholderData && (
                <span className="text-muted-foreground">End of results</span>
              )}
            </div>
          </ModelSelectorList>
        </ModelSelectorContent>
      )}
    </ModelSelectorRoot>
  );
});
