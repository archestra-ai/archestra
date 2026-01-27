"use client";

import {
  type ModelInputModality,
  providerDisplayNames,
  type SupportedProvider,
} from "@shared";
import {
  CheckIcon,
  FileText,
  ImageIcon,
  Loader2,
  Mic,
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
  useModelsByProviderQuery,
} from "@/lib/chat-models.query";
import { cn } from "@/lib/utils";

/** Modalities that can be filtered (excludes "text" since all models support it) */
type FilterableModality = Exclude<ModelInputModality, "text">;

/** Filter configuration for a modality */
type ModalityFilterConfig = {
  modality: FilterableModality;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  tooltip: string;
};

/** Available modality filters */
const MODALITY_FILTERS: ModalityFilterConfig[] = [
  {
    modality: "image",
    icon: ImageIcon,
    label: "Vision",
    tooltip: "Filter by models which support image input",
  },
  {
    modality: "audio",
    icon: Mic,
    label: "Audio",
    tooltip: "Filter by models which support audio input",
  },
  {
    modality: "video",
    icon: Video,
    label: "Video",
    tooltip: "Filter by models which support video input",
  },
  {
    modality: "pdf",
    icon: FileText,
    label: "PDF",
    tooltip: "Filter by models which support PDF input",
  },
];

/** Tool calling filter config */
const TOOL_CALLING_FILTER = {
  icon: Settings2,
  label: "Tools",
  tooltip: "Filter by models which support tool calls",
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
}

/** Map our provider names to logo provider names */
const providerToLogoProvider: Record<SupportedProvider, string> = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "google",
  cerebras: "cerebras",
  cohere: "cohere",
  mistral: "mistral",
  vllm: "vllm",
  ollama: "ollama",
  zhipuai: "zhipuai",
};

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
  if (!capabilities) {
    return null;
  }

  const hasVision = capabilities.inputModalities?.includes("image");
  const hasAudio = capabilities.inputModalities?.includes("audio");
  const hasVideo = capabilities.inputModalities?.includes("video");
  const hasPdf = capabilities.inputModalities?.includes("pdf");
  const hasToolCalling = capabilities.supportsToolCalling;

  // Don't render if no capabilities to show
  if (!hasVision && !hasAudio && !hasVideo && !hasPdf && !hasToolCalling) {
    return null;
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
  tooltip,
  pressed,
  onPressedChange,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  tooltip: string;
  pressed: boolean;
  onPressedChange: (pressed: boolean) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
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
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Filter bar for model capabilities.
 */
function ModelFiltersBar({
  filters,
  onFiltersChange,
  availableModalities,
}: {
  filters: ModelFilters;
  onFiltersChange: (filters: ModelFilters) => void;
  availableModalities: Set<FilterableModality>;
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

  // Don't render if no filters to show
  if (visibleModalityFilters.length === 0) {
    return null;
  }

  return (
    <TooltipProvider delayDuration={500} skipDelayDuration={300}>
      <div className="flex items-center gap-1 px-3 py-2 border-b">
        <span className="text-xs text-muted-foreground mr-1">Filter:</span>
        <div className="flex flex-wrap items-center gap-1 flex-1">
          {visibleModalityFilters.map((config) => (
            <FilterToggle
              key={config.modality}
              icon={config.icon}
              label={config.label}
              tooltip={config.tooltip}
              pressed={filters.modalities.has(config.modality)}
              onPressedChange={(pressed) =>
                toggleModality(config.modality, pressed)
              }
            />
          ))}
          <FilterToggle
            icon={TOOL_CALLING_FILTER.icon}
            label={TOOL_CALLING_FILTER.label}
            tooltip={TOOL_CALLING_FILTER.tooltip}
            pressed={filters.toolCalling}
            onPressedChange={toggleToolCalling}
          />
        </div>
        <DialogClose className="rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
          <XIcon className="size-4" />
          <span className="sr-only">Close</span>
        </DialogClose>
      </div>
    </TooltipProvider>
  );
}

/**
 * Checks if a model matches the given filters.
 */
function modelMatchesFilters(model: ChatModel, filters: ModelFilters): boolean {
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
}: ModelSelectorProps) {
  const { modelsByProvider, isLoading } = useModelsByProviderQuery();
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

  const handleSelectModel = (model: string) => {
    // If selecting the same model, just close the dialog
    if (model === selectedModel) {
      handleOpenChange(false);
      return;
    }

    handleOpenChange(false);
    onModelChange(model);
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
                {filteredModelsByProvider[provider]?.map((model) => (
                  <ModelSelectorItem
                    key={model.id}
                    value={model.id}
                    onSelect={() => handleSelectModel(model.id)}
                  >
                    <ModelSelectorLogo
                      provider={providerToLogoProvider[provider]}
                    />
                    <ModelSelectorName>{model.displayName}</ModelSelectorName>
                    <div className="ml-auto flex items-center gap-2">
                      <ModelCapabilityBadges
                        capabilities={model.capabilities}
                      />
                      {selectedModel === model.id ? (
                        <CheckIcon className="size-4" />
                      ) : (
                        <div className="size-4" />
                      )}
                    </div>
                  </ModelSelectorItem>
                ))}
              </ModelSelectorGroup>
            ))}
          </ModelSelectorList>
        </ModelSelectorContent>
      </ModelSelectorRoot>
    </div>
  );
}
