"use client";

import {
  E2eTestId,
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
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { UnknownCapabilitiesBadge } from "@/components/model-badges";
import { Button } from "@/components/ui/button";
import { DialogClose } from "@/components/ui/dialog";
import { Toggle } from "@/components/ui/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { resolveAutoSelectedModel } from "@/lib/chat/use-chat-preferences";
import {
  type LlmModel,
  type ModelCapabilities,
  useAvailableLlmModel,
  useInfiniteLlmModelsByProvider,
  useSyncLlmModels,
} from "@/lib/llm-models.query";
import { cn } from "@/lib/utils";

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

interface ModelSelectorProps {
  /** Currently selected model */
  selectedModel: string;
  /** Callback when model is changed */
  onModelChange: (model: string) => void;
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
    <div className="flex items-center gap-0.5">
      {hasVision && (
        <CapabilityIcon icon={ImageIcon} label="Supports vision (images)" />
      )}
      {hasAudio && <CapabilityIcon icon={Mic} label="Supports audio input" />}
      {hasVideo && <CapabilityIcon icon={Video} label="Supports video input" />}
      {hasPdf && <CapabilityIcon icon={FileText} label="Supports PDF input" />}
      {hasToolCalling && (
        <CapabilityIcon icon={Settings2} label="Supports tool calling" />
      )}
    </div>
  );
}

/**
 * Formats a context length number into a human-readable string.
 * e.g., 128000 -> "128K", 1000000 -> "1M"
 */
function formatContextLength(contextLength: number): string {
  if (contextLength >= 1_000_000) {
    return `${(contextLength / 1_000_000).toFixed(contextLength % 1_000_000 === 0 ? 0 : 1)}M`;
  }
  if (contextLength >= 1_000) {
    return `${(contextLength / 1_000).toFixed(contextLength % 1_000 === 0 ? 0 : 1)}K`;
  }
  return contextLength.toString();
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
  modalities: Set<FilterableModality>;
  toolCalling: boolean;
};

/** Initial filter state - no filters active */
const INITIAL_FILTERS: ModelFilters = {
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
}: {
  filters: ModelFilters;
  onFiltersChange: (filters: ModelFilters) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
}) {
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
      <DialogClose className="rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
        <XIcon className="size-4" />
        <span className="sr-only">Close</span>
      </DialogClose>
    </div>
  );
}

/**
 * Model selector dialog with:
 * - Models grouped by provider with provider name headers
 * - Search functionality to filter models
 * - Models filtered by configured API keys
 */
export function ModelSelector({
  selectedModel,
  onModelChange,
  disabled = false,
  onOpenChange: onOpenChangeProp,
  onClear,
  variant = "default",
  apiKeyId,
  enabled = true,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<ModelFilters>(INITIAL_FILTERS);
  const [searchQuery, setSearchQuery] = useState("");
  const [loadMoreNode, setLoadMoreNode] = useState<HTMLDivElement | null>(null);

  const {
    models,
    modelsByProvider,
    isPending: isLoading,
    isFetching,
    isFetchingNextPage,
    isPlaceholderData,
    hasNextPage,
    fetchNextPage,
  } = useInfiniteLlmModelsByProvider({
    apiKeyId: apiKeyId ?? undefined,
    q: searchQuery.trim() || undefined,
    inputModalities: Array.from(filters.modalities),
    supportsToolCalling: filters.toolCalling ? "true" : undefined,
    limit: 50,
    enabled,
  });
  const selectedModelQuery = useAvailableLlmModel({
    modelId: selectedModel || null,
    apiKeyId: apiKeyId ?? undefined,
    enabled,
  });
  const syncMutation = useSyncLlmModels();

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    // Reset filters when closing the dialog
    if (!newOpen) {
      setFilters(INITIAL_FILTERS);
      setSearchQuery("");
    }
    onOpenChangeProp?.(newOpen);
  };

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

  // Get available providers from the fetched models
  const availableProviders = useMemo(() => {
    return Object.keys(modelsByProvider) as SupportedProvider[];
  }, [modelsByProvider]);

  const modelIndexes = useMemo(() => {
    const allModels: LlmModel[] = [];
    const providerByModelId = new Map<string, SupportedProvider>();
    const modelById = new Map<string, LlmModel>();

    for (const provider of availableProviders) {
      for (const model of modelsByProvider[provider] ?? []) {
        allModels.push(model);
        providerByModelId.set(model.id, provider);
        modelById.set(model.id, model);
      }
    }

    return { allModels, modelById, providerByModelId };
  }, [availableProviders, modelsByProvider]);

  const hasActiveFilters = filters.modalities.size > 0 || filters.toolCalling;

  const hasSearch = searchQuery.trim().length > 0;
  const isRefreshingResults =
    open && isFetching && !isFetchingNextPage && !isLoading;
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

  const handleSelectModel = (modelValue: string) => {
    // Parse the provider:modelId format
    const parsed = parseModelValue(modelValue);
    const modelId = parsed?.modelId ?? modelValue;

    // If selecting the same model, just close the dialog
    if (modelId === selectedModel) {
      handleOpenChange(false);
      return;
    }

    handleOpenChange(false);
    onModelChange(modelId);
  };

  const isSelectedModelLoadedInList = modelIndexes.modelById.has(selectedModel);
  const isSelectedModelMissingFromApiKey =
    !!selectedModel &&
    !isSelectedModelLoadedInList &&
    selectedModelQuery.isFetched &&
    !selectedModelQuery.isFetching &&
    !selectedModelQuery.data;

  // Auto-select only when no explicit model is selected. A selected model may
  // simply be outside the currently loaded page.
  useEffect(() => {
    if (selectedModel) return;
    const modelToSelect = resolveAutoSelectedModel({
      selectedModel,
      availableModels: modelIndexes.allModels,
      isLoading,
    });
    if (modelToSelect) {
      onModelChange(modelToSelect);
    }
  }, [isLoading, modelIndexes.allModels, selectedModel, onModelChange]);

  // If loading, show loading state
  if (isLoading && !open) {
    return (
      <PromptInputButton disabled>
        <Loader2 className="size-4 animate-spin" />
        <ModelSelectorName>Loading models...</ModelSelectorName>
      </PromptInputButton>
    );
  }

  // If no providers configured, show disabled state
  if (
    !open &&
    !selectedModel &&
    !hasActiveFilters &&
    !hasSearch &&
    availableProviders.length === 0
  ) {
    return (
      <PromptInputButton disabled>
        <ModelSelectorName>No models available</ModelSelectorName>
      </PromptInputButton>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <ModelSelectorRoot open={open} onOpenChange={handleOpenChange}>
        <ModelSelectorTrigger asChild>
          {variant === "outline" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              className="h-8 px-3 gap-1.5 text-xs max-w-[280px] min-w-0"
              data-testid={E2eTestId.ChatModelSelectorTrigger}
            >
              {selectedModelLogo && (
                <ModelSelectorLogo
                  provider={selectedModelLogo}
                  className="shrink-0"
                />
              )}
              {selectedModelDisplayName ? (
                <span className="font-medium truncate">
                  {selectedModelDisplayName}
                </span>
              ) : (
                <span className="text-muted-foreground">
                  Best available model
                </span>
              )}
              {onClear && selectedModel && (
                <button
                  type="button"
                  aria-label="Clear model"
                  className="ml-1 shrink-0 rounded-sm opacity-50 hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClear();
                  }}
                >
                  <XIcon className="size-3" />
                </button>
              )}
            </Button>
          ) : (
            <PromptInputButton
              disabled={disabled}
              className="max-w-[280px] min-w-0"
              data-testid={E2eTestId.ChatModelSelectorTrigger}
            >
              {selectedModelLogo && (
                <ModelSelectorLogo
                  provider={selectedModelLogo}
                  className="shrink-0"
                />
              )}
              <ModelSelectorName className="truncate flex-1 text-left">
                {selectedModelDisplayName || "Select model"}
              </ModelSelectorName>
              {onClear && selectedModel && (
                <button
                  type="button"
                  aria-label="Clear model"
                  className="ml-1 shrink-0 rounded-sm opacity-50 hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClear();
                  }}
                >
                  <XIcon className="size-3" />
                </button>
              )}
            </PromptInputButton>
          )}
        </ModelSelectorTrigger>
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
              onRefresh={() => syncMutation.mutate()}
              isRefreshing={syncMutation.isPending}
            />
            <DebouncedModelSelectorInput
              onDebouncedValueChange={setSearchQuery}
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
                    onSelect={() => {
                      handleOpenChange(false);
                      onClear();
                    }}
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
                    <ModelSelectorName>{selectedModel}</ModelSelectorName>
                    <CheckIcon className="ml-auto size-4" />
                  </ModelSelectorItem>
                </ModelSelectorGroup>
              )}

              {availableProviders.map((provider) => (
                <ModelSelectorGroup
                  key={provider}
                  heading={providerDisplayNames[provider]}
                >
                  {modelsByProvider[provider]?.map((model) => {
                    // Use provider:modelId format for unique keys/values
                    // This prevents issues when different providers have models with the same ID
                    const modelValue = createModelValue(provider, model.id);
                    return (
                      <ModelSelectorItem
                        key={modelValue}
                        value={modelValue}
                        onSelect={() => handleSelectModel(modelValue)}
                        className="group"
                      >
                        <ModelSelectorLogo
                          provider={providerToLogoProvider[provider]}
                        />
                        <ModelSelectorName>
                          {model.displayName}{" "}
                          <span className="text-xs text-muted-foreground font-mono">
                            ({model.id})
                          </span>
                          <CopyModelIdButton modelId={model.id} />
                        </ModelSelectorName>
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
                          {selectedModel === model.id ? (
                            <CheckIcon className="size-4" />
                          ) : (
                            <div className="size-4" />
                          )}
                        </div>
                      </ModelSelectorItem>
                    );
                  })}
                </ModelSelectorGroup>
              ))}
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
    </TooltipProvider>
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
