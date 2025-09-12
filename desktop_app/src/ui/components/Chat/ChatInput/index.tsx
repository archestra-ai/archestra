'use client';

import { FileText, X } from 'lucide-react';
import React, { useCallback, useMemo } from 'react';

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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@ui/components/ui/tooltip';
import { cn } from '@ui/lib/utils/tailwind';
import { formatToolName } from '@ui/lib/utils/tools';
import { useCloudProvidersStore, useDeveloperModeStore, useOllamaStore, useToolsStore } from '@ui/stores';
import type { Tool } from '@ui/types/tools';

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

  // Helper function to find common prefix
  const findCommonPrefix = (tools: Tool[]): string => {
    if (tools.length === 0) return '';
    
    const names = tools.map(t => formatToolName(t.name || t.id));
    if (names.length === 1) return '';
    
    let prefix = '';
    const minLength = Math.min(...names.map(n => n.length));
    
    for (let i = 0; i < minLength; i++) {
      const char = names[0][i];
      if (names.every(name => name[i] === char)) {
        prefix += char;
      } else {
        break;
      }
    }
    
    // Only remove prefix if it ends with a separator like _ or -
    const lastChar = prefix[prefix.length - 1];
    if (lastChar === '_' || lastChar === '-' || lastChar === '.') {
      return prefix;
    }
    
    // Or if the prefix is a complete word (next char is uppercase or separator)
    if (prefix.length > 0 && names.every(name => {
      const nextChar = name[prefix.length];
      return !nextChar || nextChar === '_' || nextChar === '-' || nextChar === '.' || nextChar === nextChar.toUpperCase();
    })) {
      return prefix;
    }
    
    return '';
  };

  // Group selected tools by MCP server with read/write counts
  const groupedTools = useMemo(() => {
    const groups: Record<string, { 
      tools: Tool[]; 
      readOnlyTools: Tool[];
      writeOnlyTools: Tool[];
      readWriteTools: Tool[];
      otherTools: Tool[];
      readOnlyCount: number;
      writeOnlyCount: number;
      readWriteCount: number;
      otherCount: number;
      commonPrefix: string;
    }> = {};

    Array.from(selectedToolIds).forEach((toolId) => {
      const tool = availableTools.find((t) => t.id === toolId);
      if (tool) {
        const serverName = tool.mcpServerName || 'Unknown';
        if (!groups[serverName]) {
          groups[serverName] = { 
            tools: [], 
            readOnlyTools: [],
            writeOnlyTools: [],
            readWriteTools: [],
            otherTools: [],
            readOnlyCount: 0,
            writeOnlyCount: 0,
            readWriteCount: 0,
            otherCount: 0,
            commonPrefix: ''
          };
        }
        groups[serverName].tools.push(tool);

        // Categorize based on tool analysis (both read and write flags)
        const isRead = tool.analysis?.isRead || false;
        const isWrite = tool.analysis?.isWrite || false;
        
        if (isRead && isWrite) {
          groups[serverName].readWriteCount++;
          groups[serverName].readWriteTools.push(tool);
        } else if (isRead) {
          groups[serverName].readOnlyCount++;
          groups[serverName].readOnlyTools.push(tool);
        } else if (isWrite) {
          groups[serverName].writeOnlyCount++;
          groups[serverName].writeOnlyTools.push(tool);
        } else {
          groups[serverName].otherCount++;
          groups[serverName].otherTools.push(tool);
        }
      }
    });

    // Calculate common prefixes for each server
    Object.values(groups).forEach(group => {
      group.commonPrefix = findCommonPrefix(group.tools);
    });

    return groups;
  }, [selectedToolIds, availableTools]);

  return (
    <TooltipProvider>
      <AIInput onSubmit={handleSubmit} className="bg-inherit">
        {selectedToolIds.size === 0 ? (
          <div className="p-3 pb-0">
            <div className="text-sm text-muted-foreground bg-muted/30 rounded-lg px-3 py-2 border border-muted-foreground/10">
              ⬅️ This agent is not connected to any tools, click on tools from the list on the left to connect.
            </div>
          </div>
        ) : (
          <div className={cn('flex flex-wrap gap-2 p-3 pb-0')}>
            {Object.entries(groupedTools).map(([serverName, data]) => {
              const parts = [];
              if (data.readOnlyCount > 0) parts.push(`${data.readOnlyCount} read`);
              if (data.writeOnlyCount > 0) parts.push(`${data.writeOnlyCount} write`);
              if (data.readWriteCount > 0) parts.push(`${data.readWriteCount} read/write`);
              if (data.otherCount > 0) parts.push(`${data.otherCount} other`);
              const countText = parts.join(' + ');

              return (
                <Tooltip key={serverName}>
                  <TooltipTrigger asChild>
                    <div
                      className="flex items-center gap-2 px-3 py-1.5 bg-muted/30 rounded-full border border-muted-foreground/10 group hover:bg-muted/40 transition-colors cursor-default"
                    >
                      <span className="text-sm font-medium">{serverName}</span>
                      {countText && <span className="text-xs text-muted-foreground">({countText})</span>}
                      <button
                        onClick={() => {
                          // Remove all tools from this server
                          data.tools.forEach((tool) => removeSelectedTool(tool.id));
                        }}
                        className="ml-1 hover:bg-muted-foreground/20 rounded-full p-0.5 transition-colors"
                        type="button"
                        title={`Remove all ${serverName} tools`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-sm max-h-96 overflow-y-auto">
                    <div className="space-y-3 p-1">
                      {data.readOnlyTools.length > 0 && (
                        <div>
                          <div className="text-xs font-semibold text-green-600 dark:text-green-400 mb-1.5">
                            Read Tools ({data.readOnlyTools.length})
                          </div>
                          <div className="flex flex-col gap-0.5">
                            {data.readOnlyTools.map((tool) => {
                              const fullName = formatToolName(tool.name || tool.id);
                              const displayName = data.commonPrefix ? fullName.slice(data.commonPrefix.length) : fullName;
                              return (
                                <button
                                  key={tool.id}
                                  onClick={() => removeSelectedTool(tool.id)}
                                  className="text-xs px-2 py-1 bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 rounded hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors cursor-pointer text-left"
                                  type="button"
                                  title={`Remove ${fullName}`}
                                >
                                  {displayName}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {data.readWriteTools.length > 0 && (
                        <div>
                          <div className="text-xs font-semibold text-blue-600 dark:text-blue-400 mb-1.5">
                            Read/Write Tools ({data.readWriteTools.length})
                          </div>
                          <div className="flex flex-col gap-0.5">
                            {data.readWriteTools.map((tool) => {
                              const fullName = formatToolName(tool.name || tool.id);
                              const displayName = data.commonPrefix ? fullName.slice(data.commonPrefix.length) : fullName;
                              return (
                                <button
                                  key={tool.id}
                                  onClick={() => removeSelectedTool(tool.id)}
                                  className="text-xs px-2 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 rounded hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors cursor-pointer text-left"
                                  type="button"
                                  title={`Remove ${fullName}`}
                                >
                                  {displayName}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {data.writeOnlyTools.length > 0 && (
                        <div>
                          <div className="text-xs font-semibold text-red-600 dark:text-red-400 mb-1.5">
                            Write Tools ({data.writeOnlyTools.length})
                          </div>
                          <div className="flex flex-col gap-0.5">
                            {data.writeOnlyTools.map((tool) => {
                              const fullName = formatToolName(tool.name || tool.id);
                              const displayName = data.commonPrefix ? fullName.slice(data.commonPrefix.length) : fullName;
                              return (
                                <button
                                  key={tool.id}
                                  onClick={() => removeSelectedTool(tool.id)}
                                  className="text-xs px-2 py-1 bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300 rounded hover:bg-red-200 dark:hover:bg-red-900/50 transition-colors cursor-pointer text-left"
                                  type="button"
                                  title={`Remove ${fullName}`}
                                >
                                  {displayName}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {data.otherTools.length > 0 && (
                        <div>
                          <div className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-1.5">
                            Other Tools ({data.otherTools.length})
                          </div>
                          <div className="flex flex-col gap-0.5">
                            {data.otherTools.map((tool) => {
                              const fullName = formatToolName(tool.name || tool.id);
                              const displayName = data.commonPrefix ? fullName.slice(data.commonPrefix.length) : fullName;
                              return (
                                <button
                                  key={tool.id}
                                  onClick={() => removeSelectedTool(tool.id)}
                                  className="text-xs px-2 py-1 bg-gray-100 dark:bg-gray-900/30 text-gray-800 dark:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-gray-900/50 transition-colors cursor-pointer text-left"
                                  type="button"
                                  title={`Remove ${fullName}`}
                                >
                                  {displayName}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  </TooltipContent>
                </Tooltip>
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
