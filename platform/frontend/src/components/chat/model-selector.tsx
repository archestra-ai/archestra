"use client";

import {
  modelsByProvider,
  providerDisplayNames,
  type SupportedProvider,
} from "@shared";
import { Check, ChevronDown, Search } from "lucide-react";
import { useMemo, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useChatApiKeys } from "@/lib/chat-settings.query";
import { useFeatures } from "@/lib/features.query";
import { cn } from "@/lib/utils";

interface ModelSelectorProps {
  /** Currently selected model */
  selectedModel: string;
  /** Callback when model is changed */
  onModelChange: (model: string) => void;
  /** Whether the selector should be disabled */
  disabled?: boolean;
  /** Number of messages in current conversation (for mid-conversation warning) */
  messageCount?: number;
  /** Additional className for the trigger */
  className?: string;
}

/**
 * Model selector dropdown with:
 * - Models grouped by provider with provider name headers
 * - Search functionality to filter models
 * - Models filtered by configured API keys
 * - Mid-conversation warning when switching models
 */
export function ModelSelector({
  selectedModel,
  onModelChange,
  disabled = false,
  messageCount = 0,
  className,
}: ModelSelectorProps) {
  const { data: chatApiKeys = [] } = useChatApiKeys();
  const { data: features } = useFeatures();
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  // Build available providers based on configured API keys
  const availableProviders = useMemo(() => {
    const configuredProviders = new Set<SupportedProvider>();

    // Check API keys for each provider
    for (const key of chatApiKeys) {
      if (key.secretId && key.provider) {
        configuredProviders.add(key.provider);
      }
    }

    // Gemini with Vertex AI doesn't require an API key
    if (features?.geminiVertexAiEnabled) {
      configuredProviders.add("gemini");
    }

    return (Object.keys(modelsByProvider) as SupportedProvider[]).filter(
      (provider) => configuredProviders.has(provider),
    );
  }, [chatApiKeys, features?.geminiVertexAiEnabled]);

  // Filter models based on search query
  const filteredProviderModels = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query) {
      return availableProviders.map((provider) => ({
        provider,
        models: modelsByProvider[provider],
      }));
    }

    return availableProviders
      .map((provider) => ({
        provider,
        models: modelsByProvider[provider].filter((model) =>
          model.toLowerCase().includes(query),
        ),
      }))
      .filter((group) => group.models.length > 0);
  }, [availableProviders, searchQuery]);

  const handleSelectModel = (model: string) => {
    // If selecting the same model, just close the popover
    if (model === selectedModel) {
      setOpen(false);
      setSearchQuery("");
      return;
    }

    // If there are messages, show warning dialog
    if (messageCount > 0) {
      setPendingModel(model);
    } else {
      onModelChange(model);
    }
    setOpen(false);
    setSearchQuery("");
  };

  const handleConfirmChange = () => {
    if (pendingModel) {
      onModelChange(pendingModel);
      setPendingModel(null);
    }
  };

  const handleCancelChange = () => {
    setPendingModel(null);
  };

  // Check if selectedModel is in the available models
  const allAvailableModels = useMemo(
    () => availableProviders.flatMap((provider) => modelsByProvider[provider]),
    [availableProviders],
  );
  const isModelAvailable = allAvailableModels.includes(selectedModel);

  // If no providers configured, show disabled state
  if (availableProviders.length === 0) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled
        className={cn("justify-between font-normal", className)}
      >
        <span className="truncate">No API keys configured</span>
        <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </Button>
    );
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className={cn(
              "w-[200px] justify-between font-normal",
              !isModelAvailable && "border-yellow-500",
              className,
            )}
          >
            <span className="truncate">{selectedModel || "Select model"}</span>
            <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[250px] p-0" align="start">
          {/* Search input */}
          <div className="flex items-center border-b px-3 pb-2 pt-3">
            <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
            <input
              placeholder="Search models..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          {/* Scrollable model list */}
          <div className="max-h-[300px] overflow-y-auto p-1">
            {/* Show current model if not in available list */}
            {!isModelAvailable && (
              <>
                <div className="px-2 py-1.5 text-xs font-semibold text-yellow-600">
                  Current (API key missing)
                </div>
                <button
                  type="button"
                  disabled
                  className="relative flex w-full cursor-not-allowed select-none items-center rounded-sm px-2 py-1.5 text-sm text-muted-foreground"
                >
                  <Check className="mr-2 h-4 w-4 opacity-100" />
                  <span className="truncate">{selectedModel}</span>
                </button>
                <div className="my-1 h-px bg-border" />
              </>
            )}

            {filteredProviderModels.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-muted-foreground">
                No models found.
              </div>
            ) : (
              filteredProviderModels.map((group, index) => (
                <div key={group.provider}>
                  {index > 0 && <div className="my-1 h-px bg-border" />}
                  <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
                    {providerDisplayNames[group.provider]}
                  </div>
                  {group.models.map((model) => (
                    <button
                      type="button"
                      key={model}
                      onClick={() => handleSelectModel(model)}
                      className={cn(
                        "relative flex w-full cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground",
                        selectedModel === model &&
                          "bg-accent text-accent-foreground",
                      )}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4",
                          selectedModel === model ? "opacity-100" : "opacity-0",
                        )}
                      />
                      <span className="truncate">{model}</span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* Mid-conversation warning dialog */}
      <AlertDialog
        open={!!pendingModel}
        onOpenChange={(open) => !open && handleCancelChange()}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change model mid-conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              Switching models during a conversation may affect response quality
              and consistency. The new model may not have the same context
              understanding as the previous one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmChange}>
              Change Model
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
