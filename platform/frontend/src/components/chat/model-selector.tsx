"use client";

import { providerDisplayNames, type SupportedProvider } from "@shared";
import { CheckIcon, Eye, Loader2, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type ModelCapabilities,
  useModelsByProviderQuery,
} from "@/lib/chat-models.query";

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
  vllm: "vllm",
  ollama: "ollama",
  zhipuai: "zhipuai",
};

/**
 * Format context length for display (e.g., 128000 -> "128K")
 */
function formatContextLength(length: number | null): string | null {
  if (!length) return null;
  if (length >= 1_000_000) {
    return `${(length / 1_000_000).toFixed(1)}M`;
  }
  if (length >= 1000) {
    return `${Math.round(length / 1000)}K`;
  }
  return length.toString();
}

/**
 * Displays capability icons for a model.
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
  const hasToolCalling = capabilities.supportsToolCalling;
  const contextLength = formatContextLength(capabilities.contextLength);

  // Don't render if no capabilities to show
  if (!hasVision && !hasToolCalling && !contextLength) {
    return null;
  }

  return (
    <TooltipProvider>
      <div className="flex items-center gap-1">
        {hasVision && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Eye className="size-3 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              Supports vision (image input)
            </TooltipContent>
          </Tooltip>
        )}
        {hasToolCalling && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Wrench className="size-3 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              Supports tool/function calling
            </TooltipContent>
          </Tooltip>
        )}
        {contextLength && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[10px] text-muted-foreground font-medium">
                {contextLength}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              Context window: {capabilities.contextLength?.toLocaleString()}{" "}
              tokens
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
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
}: ModelSelectorProps) {
  const { modelsByProvider, isLoading } = useModelsByProviderQuery();
  const [open, setOpen] = useState(false);

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    onOpenChangeProp?.(newOpen);
  };

  // Get available providers from the fetched models
  const availableProviders = useMemo(() => {
    return Object.keys(modelsByProvider) as SupportedProvider[];
  }, [modelsByProvider]);

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
        >
          <ModelSelectorInput placeholder="Search models..." />
          <ModelSelectorList>
            <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>

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

            {availableProviders.map((provider) => (
              <ModelSelectorGroup
                key={provider}
                heading={providerDisplayNames[provider]}
              >
                {modelsByProvider[provider]?.map((model) => (
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
