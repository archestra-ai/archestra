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
import { useCallback, useMemo, useState } from "react";
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
import { DialogClose } from "@/components/ui/dialog";
import { Toggle } from "@/components/ui/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type ChatModel,
  type ModelCapabilities,
  useModelsByProvider,
} from "@/lib/chat-models.query";
import { useSyncChatModels } from "@/lib/chat-settings.query";
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
}

/** Map our provider names to logo provider names
 * models.dev provider IDs
 * see https://github.com/anomalyco/models.dev/tree/dev/providers
 * */
const providerToLogoProvider: Record<SupportedProvider, string> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "google",
  bedrock: "amazon-bedrock",
  cerebras: "cerebras",
  cohere: "cohere",
  mistral: "mistral",
  vllm: "vllm",
  ollama: "ollama-cloud", // models.dev uses ollama-cloud for the Ollama provider
  zhipuai: "zhipuai",
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
    return (
      <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
        capabilities unknown
      </span>
    );
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
  availableModalities,
  onRefresh,
  isRefreshing,
}: {
  filters: ModelFilters;
  onFiltersChange: (filters: ModelFilters) => void;
  availableModalities: Set<FilterableModality>;
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

  // Only show modality filters that are available in the model list
  const visibleModalityFilters = MODALITY_FILTERS.filter((f) =>
    availableModalities.has(f.modality),
  );

  return (
    <div className="flex items-center gap-1 px-3 py-2 border-b">
      {visibleModalityFilters.length > 0 && (
        <>
          <span className="text-xs text-muted-foreground mr-1">Filter:</span>
          <div className="flex flex-wrap items-center gap-1 flex-1">
            {visibleModalityFilters.map((config) => (
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
        </>
      )}
      {visibleModalityFilters.length === 0 && <div className="flex-1" />}
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

/**
 * Checks if a model has unknown capabilities (no data available).
 */
function hasUnknownCapabilities(model: ChatModel): boolean {
  const capabilities = model.capabilities;
  if (!capabilities) return true;

  const hasVision = capabilities.inputModalities?.includes("image");
  const hasAudio = capabilities.inputModalities?.includes("audio");
  const hasVideo = capabilities.inputModalities?.includes("video");
  const hasPdf = capabilities.inputModalities?.includes("pdf");
  const hasToolCalling = capabilities.supportsToolCalling;

  return !hasVision && !hasAudio && !hasVideo && !hasPdf && !hasToolCalling;
}

/**
 * Checks if a model matches the given filters.
 * Models with unknown capabilities are always shown.
 */
function modelMatchesFilters(model: ChatModel, filters: ModelFilters): boolean {
  // Always show models with unknown capabilities
  if (hasUnknownCapabilities(model)) {
    return true;
  }

  const capabilities = model.capabilities;

  // Check modality filters (AND logic - model must support all selected modalities)
  for (const modality of filters.modalities) {
    if (!capabilities?.inputModalities?.includes(modality)) {
      return false;
    }
  }

  // Check tool calling filter
  if (filters.toolCalling && !capabilities?.supportsToolCalling) {
    return false;
  }

  return true;
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
}: ModelSelectorProps) {
  const { modelsByProvider, isPending: isLoading } = useModelsByProvider();
  const syncMutation = useSyncChatModels();
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<ModelFilters>(INITIAL_FILTERS);

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    // Reset filters when closing the dialog
    if (!newOpen) {
      setFilters(INITIAL_FILTERS);
    }
    onOpenChangeProp?.(newOpen);
  };

  // Get available providers from the fetched models
  const availableProviders = useMemo(() => {
    return Object.keys(modelsByProvider) as SupportedProvider[];
  }, [modelsByProvider]);

  // Calculate which modalities are available across all models
  const availableModalities = useMemo(() => {
    const modalities = new Set<FilterableModality>();
    for (const provider of availableProviders) {
      for (const model of modelsByProvider[provider] ?? []) {
        const inputMods = model.capabilities?.inputModalities ?? [];
        for (const mod of inputMods) {
          if (mod !== "text") {
            modalities.add(mod as FilterableModality);
          }
        }
      }
    }
    return modalities;
  }, [availableProviders, modelsByProvider]);

  // Check if any filters are active
  const hasActiveFilters = filters.modalities.size > 0 || filters.toolCalling;

  // Filter models by provider based on active filters
  const filteredModelsByProvider = useMemo(() => {
    if (!hasActiveFilters) {
      return modelsByProvider;
    }

    const filtered: Partial<Record<SupportedProvider, ChatModel[]>> = {};
    for (const provider of availableProviders) {
      const models = modelsByProvider[provider] ?? [];
      const matchingModels = models.filter((model) =>
        modelMatchesFilters(model, filters),
      );
      if (matchingModels.length > 0) {
        filtered[provider] = matchingModels;
      }
    }
    return filtered;
  }, [modelsByProvider, availableProviders, filters, hasActiveFilters]);

  // Get filtered providers (only those with matching models)
  const filteredProviders = useMemo(() => {
    return Object.keys(filteredModelsByProvider) as SupportedProvider[];
  }, [filteredModelsByProvider]);

  // Find the provider for a given model
  const getProviderForModel = (model: string): SupportedProvider | null => {
    for (const provider of availableProviders) {
      if (modelsByProvider[provider]?.some((m) => m.id === model)) {
        return provider;
      }
    }
    return null;
  };

  // Get selected model's provider for logo
  const selectedModelProvider = getProviderForModel(selectedModel);
  const selectedModelLogo = selectedModelProvider
    ? providerToLogoProvider[selectedModelProvider]
    : null;

  // Get display name for selected model
  const selectedModelDisplayName = useMemo(() => {
    for (const provider of availableProviders) {
      const model = modelsByProvider[provider]?.find(
        (m) => m.id === selectedModel,
      );
      if (model) return model.displayName;
    }
    return selectedModel; // Fall back to ID if not found
  }, [selectedModel, availableProviders, modelsByProvider]);

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

  // Check if selectedModel is in the available models
  const allAvailableModelIds = useMemo(
    () =>
      availableProviders.flatMap(
        (provider) => modelsByProvider[provider]?.map((m) => m.id) ?? [],
      ),
    [availableProviders, modelsByProvider],
  );
  const isModelAvailable = allAvailableModelIds.includes(selectedModel);

  // If loading, show loading state
  if (isLoading) {
    return (
      <PromptInputButton disabled>
        <Loader2 className="size-4 animate-spin" />
        <ModelSelectorName>Loading models...</ModelSelectorName>
      </PromptInputButton>
    );
  }

  // If no providers configured, show disabled state
  if (availableProviders.length === 0) {
    return (
      <PromptInputButton disabled>
        <ModelSelectorName>No models available</ModelSelectorName>
      </PromptInputButton>
    );
  }

  return (
    <div>
      <ModelSelectorRoot open={open} onOpenChange={handleOpenChange}>
        <ModelSelectorTrigger asChild>
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
        </ModelSelectorTrigger>
        <ModelSelectorContent
          title="Select Model"
          onCloseAutoFocus={(e) => e.preventDefault()}
          showCloseButton={false}
        >
          <ModelFiltersBar
            filters={filters}
            onFiltersChange={setFilters}
            availableModalities={availableModalities}
            onRefresh={() => syncMutation.mutate()}
            isRefreshing={syncMutation.isPending}
          />
          <ModelSelectorInput placeholder="Search models..." />
          <ModelSelectorList>
            <ModelSelectorEmpty>
              {hasActiveFilters
                ? "No models match the selected filters."
                : "No models found."}
            </ModelSelectorEmpty>

            {/* Show current model if not in available list */}
            {!isModelAvailable && selectedModel && (
              <ModelSelectorGroup heading="Current (API key missing)">
                <ModelSelectorItem
                  disabled
                  value={selectedModel}
                  className="text-yellow-600"
                >
                  {selectedModelLogo && (
                    <ModelSelectorLogo provider={selectedModelLogo} />
                  )}
                  <ModelSelectorName>{selectedModel}</ModelSelectorName>
                  <CheckIcon className="ml-auto size-4" />
                </ModelSelectorItem>
              </ModelSelectorGroup>
            )}

            {filteredProviders.map((provider) => (
              <ModelSelectorGroup
                key={provider}
                heading={providerDisplayNames[provider]}
              >
                {filteredModelsByProvider[provider]?.map((model) => {
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
          </ModelSelectorList>
        </ModelSelectorContent>
      </ModelSelectorRoot>
    </div>
  );
}
