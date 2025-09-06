'use client';

import { FileText, X } from 'lucide-react';
import React, { useCallback } from 'react';

import {
  AIInput,
  AIInputButton,
  AIInputModelSelect,
  AIInputModelSelectContent,
  AIInputModelSelectItem,
  AIInputModelSelectTrigger,
  AIInputModelSelectValue,
  AIInputSubmit,
  AIInputTextarea,
  AIInputToolbar,
  AIInputTools,
} from '@ui/components/kibo/ai-input';
import { Badge } from '@ui/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@ui/components/ui/tooltip';
import { cn } from '@ui/lib/utils/tailwind';
import { formatToolName } from '@ui/lib/utils/tools';
import { useCloudProvidersStore, useDeveloperModeStore, useOllamaStore, useToolsStore } from '@ui/stores';

interface ChatInputProps {
  input: string;
  handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  handleSubmit: (e?: React.FormEvent<HTMLFormElement>) => void;
  isLoading: boolean;
  isSubmitting?: boolean;
  stop: () => void;
}

export default function ChatInput({
  input,
  handleInputChange,
  handleSubmit,
  isLoading,
  isSubmitting = false,
  stop,
}: ChatInputProps) {
  const { isDeveloperMode, toggleDeveloperMode } = useDeveloperModeStore();
  const { installedModels, selectedModel, setSelectedModel } = useOllamaStore();
  const { availableCloudProviderModels } = useCloudProvidersStore();
  const { availableTools, selectedToolIds, removeSelectedTool } = useToolsStore();

  // Use the selected model from Ollama store
  const currentModel = selectedModel || '';
  const handleModelChange = setSelectedModel;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit]
  );

  return (
    <TooltipProvider>
      <AIInput onSubmit={handleSubmit} className="bg-inherit">
        {selectedToolIds.size > 0 && (
          <div className={cn('flex flex-wrap gap-2 p-3 pb-0')}>
            {Array.from(selectedToolIds).map((toolId) => {
              const tool = availableTools.find((t) => t.id === toolId);
              if (!tool) return null;

              return (
                <Badge key={tool.id} variant="secondary" className="flex items-center gap-1.5 px-2 py-1 text-xs">
                  <span className="text-xs font-medium text-muted-foreground">{tool.mcpServerName}</span>
                  <span>/</span>
                  <span>{formatToolName(tool.name || tool.id)}</span>
                  <button
                    onClick={() => removeSelectedTool(tool.id)}
                    className="ml-1 hover:bg-muted-foreground/20 rounded-full p-0.5"
                    type="button"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              );
            })}
          </div>
        )}
        <AIInputTextarea
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder="What would you like to know?"
          disabled={false}
          minHeight={48}
          maxHeight={164}
        />
        <AIInputToolbar>
          <AIInputTools>
            <AIInputModelSelect value={currentModel} onValueChange={handleModelChange} disabled={false}>
              <AIInputModelSelectTrigger>
                <AIInputModelSelectValue placeholder="Select a model" />
              </AIInputModelSelectTrigger>
              <AIInputModelSelectContent>
                {/* Local Ollama Models */}
                {installedModels.length > 0 && (
                  <>
                    <div className="px-2 py-1.5 text-sm font-semibold text-muted-foreground">Local (Ollama)</div>
                    {installedModels.map((model) => (
                      <AIInputModelSelectItem key={model.model} value={model.model}>
                        {model.name || model.model}
                      </AIInputModelSelectItem>
                    ))}
                  </>
                )}

                {/* Cloud Provider Models */}
                {availableCloudProviderModels.length > 0 && (
                  <>
                    <div className="px-2 py-1.5 text-sm font-semibold text-muted-foreground">Cloud Providers</div>
                    {availableCloudProviderModels.map((model) => (
                      <AIInputModelSelectItem key={model.id} value={model.id}>
                        {model.id} ({model.provider})
                      </AIInputModelSelectItem>
                    ))}
                  </>
                )}
              </AIInputModelSelectContent>
            </AIInputModelSelect>
            <Tooltip>
              <TooltipTrigger asChild>
                <AIInputButton onClick={toggleDeveloperMode} className={isDeveloperMode ? 'bg-primary/20' : ''}>
                  <FileText size={16} />
                </AIInputButton>
              </TooltipTrigger>
              <TooltipContent>
                <span>Toggle system prompt</span>
              </TooltipContent>
            </Tooltip>
          </AIInputTools>

          <AIInputSubmit
            onClick={isLoading ? stop : undefined}
            disabled={!input.trim() && !isLoading && !isSubmitting}
          />
        </AIInputToolbar>
      </AIInput>
    </TooltipProvider>
  );
}
