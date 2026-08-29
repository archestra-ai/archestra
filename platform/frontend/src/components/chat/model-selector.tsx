"use client";

import {
  compareModelsForDisplay,
  E2eTestId,
  isLegacyGeminiModel,
  isOpenRouterLatestAlias,
  type ModelInputModality,
  requiresPerplexityAgentApi,
  type SubscriptionCredentialKind,
  type SupportedProvider,
} from "@archestra/shared";
import {
  CheckIcon,
  CopyIcon,
  DollarSign,
  FileText,
  ImageIcon,
  Loader2,
  Mic,
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
  ConnectAccountBadge,
  FreeModelBadge,
  LatestModelBadge,
  OldModelBadge,
} from "@/components/model-badges";
import {
  ModelCapabilityBadges,
  ModelContextLengthIndicator,
} from "@/components/model-capability-indicators";
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
import { copyToClipboard } from "@/lib/clipboard";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { type LlmModel, useLlmModelsByProvider } from "@/lib/llm-models.query";
import { useAvailableLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { formatPricePerMillion } from "@/lib/model-price-format";
import { logoNameForProvider } from "@/lib/provider-logos";
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
  /**
   * What the trigger says while no model is selected. The default names the
   * runtime's own fallback; a host that knows what will actually answer (the
   * organization's default model) passes that instead.
   */
  placeholder?: string;
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
  /**
   * Keep the current (unavailable) model instead of auto-selecting a fallback.
   * Used when the agent pins a per-user-credential model (e.g. GitHub Copilot)
   * the viewer hasn't connected: we surface a "connect" prompt on send rather
   * than silently substituting a different provider's model.
   */
  suppressAutoSelect?: boolean;
  /**
   * Display name to show when `selectedModel` isn't in the viewer's available
   * models (e.g. a per-user model they can't access). Without it the trigger
   * would fall back to the raw model UUID.
   */
  fallbackModelName?: string;
}

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

/** Shared model ordering (routers, recommended, then the rest alphabetically). */
function compareLlmModels(a: LlmModel, b: LlmModel): number {
  return compareModelsForDisplay(
    { modelId: a.id, isBest: a.isBest },
    { modelId: b.id, isBest: b.isBest },
  );
}

type ProviderModelSection = {
  key: string;
  heading: string;
  models: LlmModel[];
};

/**
 * A provider that serves more than one API splits its group into one section
 * per backing API, so the list reads as what each model actually speaks.
 *
 * Perplexity: the chat-completions `sonar*` family leads — it is the
 * provider's default surface — and the vendor-prefixed Agent API catalog
 * (the tool-calling one) follows. The section keys reuse the interaction-type
 * strings that name these transports everywhere else.
 */
const PROVIDER_MODEL_SECTIONERS: Partial<
  Record<
    SupportedProvider,
    (models: LlmModel[], providerLabel: string) => ProviderModelSection[]
  >
> = {
  perplexity: (models, providerLabel) => [
    {
      key: "perplexity:chatCompletions",
      heading: `${providerLabel} — Chat Completions`,
      models: models.filter((model) => !requiresPerplexityAgentApi(model.id)),
    },
    {
      key: "perplexity:responses",
      heading: `${providerLabel} — Agent API`,
      models: models.filter((model) => requiresPerplexityAgentApi(model.id)),
    },
  ],
};

function providerModelSections(
  provider: SupportedProvider,
  models: LlmModel[],
  /** What this organization calls the provider (see integration overrides). */
  providerLabel: string,
): ProviderModelSection[] {
  const sections = PROVIDER_MODEL_SECTIONERS[provider]?.(
    models,
    providerLabel,
  ) ?? [{ key: provider, heading: providerLabel, models }];
  return sections.filter((section) => section.models.length > 0);
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
              <span>
                {`Input: $${formatPricePerMillion(pricePerMillionInput)}/M tokens`}
              </span>
            )}
            {pricePerMillionOutput && (
              <span>
                {`Output: $${formatPricePerMillion(pricePerMillionOutput)}/M tokens`}
              </span>
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
        await copyToClipboard(modelId);
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
function hasUnknownCapabilities(model: LlmModel): boolean {
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
function modelMatchesFilters(model: LlmModel, filters: ModelFilters): boolean {
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
export const ModelSelector = memo(function ModelSelector({
  selectedModel,
  onModelChange,
  disabled = false,
  placeholder,
  onOpenChange: onOpenChangeProp,
  onClear,
  variant = "default",
  apiKeyId,
  enabled = true,
  suppressAutoSelect = false,
  fallbackModelName,
}: ModelSelectorProps) {
  const { modelsByProvider, isLoading, isPlaceholderData } =
    useLlmModelsByProvider({
      apiKeyId: apiKeyId ?? undefined,
      enabled,
    });
  const { data: availableKeys } = useAvailableLlmProviderApiKeys({
    includeKeyId: apiKeyId ?? undefined,
    toastOnError: false,
  });
  const selectedKeySubscriptionKind =
    availableKeys?.find((key) => key.id === apiKeyId)?.subscriptionKind ?? null;
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
      if (modelsByProvider[provider]?.some((m) => m.dbId === model)) {
        return provider;
      }
    }
    return null;
  };

  // Get selected model's provider for logo
  const selectedModelProvider = getProviderForModel(selectedModel);
  const selectedModelLogo = selectedModelProvider
    ? logoNameForProvider(selectedModelProvider, selectedKeySubscriptionKind)
    : null;

  // Get display name for selected model
  const selectedModelDisplayName = useMemo(() => {
    for (const provider of availableProviders) {
      const model = modelsByProvider[provider]?.find(
        (m) => m.dbId === selectedModel,
      );
      if (model) return model.displayName;
    }
    // Not in the viewer's available models (e.g. a per-user model they can't
    // access): prefer the server-resolved name over the raw model UUID.
    return fallbackModelName ?? selectedModel;
  }, [selectedModel, availableProviders, modelsByProvider, fallbackModelName]);

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

  // All available models flattened (filtered by apiKeyId)
  const allAvailableModels = useMemo(
    () =>
      availableProviders.flatMap(
        (provider) => modelsByProvider[provider] ?? [],
      ),
    [availableProviders, modelsByProvider],
  );
  const allAvailableModelIds = useMemo(
    () => allAvailableModels.map((m) => m.dbId),
    [allAvailableModels],
  );
  const isModelAvailable = allAvailableModelIds.includes(selectedModel);

  // Auto-select the "best" model (or first) when the selected model is not
  // in the available list (e.g. after switching API keys or on initial load).
  // Only triggers when the model is genuinely unavailable — keeps the user's
  // selection stable across API key changes if the model is still valid.
  // Skip when using placeholder (stale) data from a previous apiKeyId query —
  // the stale models would incorrectly trigger auto-select for the wrong provider.
  useEffect(() => {
    if (isPlaceholderData) return;
    // The agent pins a per-user-credential model the viewer hasn't connected;
    // keep it selected so the send surfaces a connect prompt instead of
    // silently switching to another provider's model.
    if (suppressAutoSelect) return;
    const modelToSelect = resolveAutoSelectedModel({
      selectedModel,
      availableModels: allAvailableModels.map((m) => ({
        id: m.dbId,
        isBest: m.isBest,
        requiresUserConnection: m.requiresUserConnection,
        isConnected: m.isConnected,
      })),
      isLoading,
    });
    if (modelToSelect) {
      subscriptionDebug("model auto-select", {
        selectedModelId: selectedModel,
        nextModelId: modelToSelect,
        suppressAutoSelect,
        isPlaceholderData,
      });
      onModelChange(modelToSelect);
    }
  }, [
    isLoading,
    isPlaceholderData,
    suppressAutoSelect,
    allAvailableModels,
    selectedModel,
    onModelChange,
  ]);

  // If loading, show loading state
  if (isLoading) {
    return (
      <PromptInputButton className="w-[150px]" disabled>
        <Loader2 className="size-4 animate-spin" />
        <ModelSelectorName>Loading models...</ModelSelectorName>
      </PromptInputButton>
    );
  }

  // If no providers configured, show disabled state
  if (availableProviders.length === 0) {
    return (
      <PromptInputButton className="w-[150px]" disabled>
        <ModelSelectorName>No models available</ModelSelectorName>
      </PromptInputButton>
    );
  }

  // The clear control is a sibling of the trigger, not a child: the trigger is
  // itself a <button>, and a nested one is invalid HTML that breaks hydration
  // and cannot be reached by keyboard on its own.
  const showClear = Boolean(onClear && selectedModel);

  return (
    <div className="relative inline-flex min-w-0 items-center">
      <ModelSelectorRoot open={open} onOpenChange={handleOpenChange}>
        <ModelSelectorTrigger asChild>
          {variant === "outline" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              className={cn(
                "h-8 px-3 gap-1.5 text-xs max-w-[280px] min-w-0",
                showClear && "pr-7",
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
                <span className="font-medium truncate">
                  {selectedModelDisplayName}
                </span>
              ) : (
                <span className="text-muted-foreground">
                  {placeholder ?? "Best available model"}
                </span>
              )}
            </Button>
          ) : (
            <PromptInputButton
              disabled={disabled}
              className={cn("max-w-[280px] min-w-0", showClear && "pr-7")}
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
            </PromptInputButton>
          )}
        </ModelSelectorTrigger>
        {/* The option tree is expensive to build with many models, so it is
            only mounted while the dialog is open — a closed selector must not
            rebuild it on every toolbar rerender. Unmounting on close also
            resets the capability filters. */}
        {open && (
          <ModelSelectorContent
            title="Select Model"
            onCloseAutoFocus={(e) => e.preventDefault()}
            showCloseButton={false}
          >
            <ModelSelectorDialogBody
              modelsByProvider={modelsByProvider}
              availableProviders={availableProviders}
              selectedModel={selectedModel}
              selectedModelLogo={selectedModelLogo}
              selectedKeySubscriptionKind={selectedKeySubscriptionKind}
              isModelAvailable={isModelAvailable}
              onClear={onClear}
              onSelectModel={handleSelectModel}
              onClose={() => handleOpenChange(false)}
            />
          </ModelSelectorContent>
        )}
      </ModelSelectorRoot>
      {showClear && (
        <button
          type="button"
          aria-label="Clear model"
          disabled={disabled}
          className="absolute right-2 top-1/2 -translate-y-1/2 shrink-0 rounded-sm opacity-50 hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
          onClick={onClear}
        >
          <XIcon className="size-3" />
        </button>
      )}
    </div>
  );
});

/**
 * Body of the model selector dialog: capability filter bar, search input, and
 * the provider-grouped option tree. Mounted only while the dialog is open, so
 * the (potentially large) option tree is never built for a closed selector.
 * Filter state lives here and resets naturally when the dialog closes.
 */
function ModelSelectorDialogBody({
  modelsByProvider,
  availableProviders,
  selectedModel,
  selectedModelLogo,
  selectedKeySubscriptionKind,
  isModelAvailable,
  onClear,
  onSelectModel,
  onClose,
}: {
  modelsByProvider: Record<SupportedProvider, LlmModel[]>;
  availableProviders: SupportedProvider[];
  selectedModel: string;
  selectedModelLogo: string | null;
  selectedKeySubscriptionKind: SubscriptionCredentialKind | null;
  isModelAvailable: boolean;
  onClear?: () => void;
  onSelectModel: (modelValue: string) => void;
  onClose: () => void;
}) {
  const [filters, setFilters] = useState<ModelFilters>(INITIAL_FILTERS);
  const providerCatalog = useModelProviderCatalog();

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

    const filtered: Partial<Record<SupportedProvider, LlmModel[]>> = {};
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

  // Sort once per data change rather than on every render inside the JSX map.
  const sortedModelsByProvider = useMemo(() => {
    const sorted: Partial<Record<SupportedProvider, LlmModel[]>> = {};
    for (const provider of filteredProviders) {
      sorted[provider] = [...(filteredModelsByProvider[provider] ?? [])].sort(
        compareLlmModels,
      );
    }
    return sorted;
  }, [filteredModelsByProvider, filteredProviders]);

  return (
    <>
      <ModelFiltersBar
        filters={filters}
        onFiltersChange={setFilters}
        availableModalities={availableModalities}
      />
      <ModelSelectorInput placeholder="Search models..." autoFocus />
      <ModelSelectorList>
        <ModelSelectorEmpty>
          {hasActiveFilters
            ? "No models match the selected filters."
            : "No models found."}
        </ModelSelectorEmpty>

        {/* Option to unselect model */}
        {onClear && (
          <ModelSelectorGroup heading="">
            <ModelSelectorItem
              value="__none__"
              onSelect={() => {
                onClose();
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

        {filteredProviders.flatMap((provider) =>
          providerModelSections(
            provider,
            sortedModelsByProvider[provider] ?? [],
            providerCatalog.label(provider),
          ).map((section) => (
            <ModelSelectorGroup key={section.key} heading={section.heading}>
              {section.models.map((model) => {
                // Use provider:modelId format for unique keys/values
                // This prevents issues when different providers have models with the same ID
                const modelValue = createModelValue(provider, model.dbId);
                return (
                  <ModelSelectorItem
                    key={modelValue}
                    value={modelValue}
                    // value is provider:dbId (a UUID) for stable selection,
                    // so search must match human-readable terms via keywords
                    keywords={[model.displayName, model.id, section.heading]}
                    onSelect={() => onSelectModel(modelValue)}
                    className="group"
                  >
                    <ModelSelectorLogo
                      provider={logoNameForProvider(
                        provider,
                        selectedKeySubscriptionKind,
                      )}
                    />
                    <ModelSelectorName>
                      {model.displayName}{" "}
                      <span className="text-xs text-muted-foreground font-mono">
                        ({model.id})
                      </span>
                      <CopyModelIdButton modelId={model.id} />
                    </ModelSelectorName>
                    {model.isFree && <FreeModelBadge />}
                    {model.requiresUserConnection && !model.isConnected && (
                      <ConnectAccountBadge />
                    )}
                    {isOpenRouterLatestAlias(provider, model.id) && (
                      <LatestModelBadge />
                    )}
                    {provider === "gemini" && isLegacyGeminiModel(model.id) && (
                      <OldModelBadge />
                    )}
                    <div className="ml-auto flex items-center gap-2">
                      <ModelCapabilityBadges
                        capabilities={model.capabilities}
                      />
                      <ModelContextLengthIndicator
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
                      {selectedModel === model.dbId ? (
                        <CheckIcon className="size-4" />
                      ) : (
                        <div className="size-4" />
                      )}
                    </div>
                  </ModelSelectorItem>
                );
              })}
            </ModelSelectorGroup>
          )),
        )}
      </ModelSelectorList>
    </>
  );
}

function subscriptionDebug(event: string, data: Record<string, unknown>) {
  console.info(`[subscription-debug] ${event}`, data);
}
