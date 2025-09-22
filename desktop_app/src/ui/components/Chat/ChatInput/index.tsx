'use client';

import { Link } from '@tanstack/react-router';
import { AlertCircle, FileText, Loader2, Mic, MicOff, RefreshCw, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';

import { deconstructToolId } from '@constants';
import ChatTokenUsage from '@ui/components/ChatTokenUsage';
import { ToolHoverCard } from '@ui/components/ToolHoverCard';
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
import {
  useChatStore,
  useCloudProvidersStore,
  useDeveloperModeStore,
  useMcpServersStore,
  useToolsStore,
  useUserSelectableModels,
} from '@ui/stores';
import { ChatMessageStatus } from '@ui/types/chat';
import type { Tool } from '@ui/types/tools';

import './chat-input.css';

interface ChatInputProps {
  input: string;
  handleInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  handleSubmit: (e?: React.FormEvent<HTMLFormElement>) => void;
  isLoading: boolean;
  isPreparing: boolean;
  disabled: boolean;
  rerunAgentDisabled: boolean;
  stop: () => void;
  hasMessages?: boolean;
  onRerunAgent?: () => void;
  status?: 'submitted' | 'streaming' | 'ready' | 'error';
  isSubmitting?: boolean;
}

const PLACEHOLDER_EXAMPLES = [
  "For example: Read my gmail inbox, find all questions from investors, check slack's #general channel and prepare answers as email drafts",
  'For example: Open my linkedin and find all people who mention AI in their profile. Give me a list sorted by mutual connections',
  'For example: Analyze my calendar for next week and suggest optimal meeting times for a 2-hour workshop',
  'For example: Review my GitHub PRs, summarize the feedback, and draft responses for each comment',
  'For example: Check my Notion tasks, prioritize them by deadline, and create a daily schedule for tomorrow',
  'For example: Search my Google Drive for quarterly reports, extract key metrics, and create a summary table',
  'For example: Monitor my Twitter mentions, identify customer complaints, and draft personalized responses',
  'For example: Scan my Jira tickets, identify blockers, and suggest solutions based on similar resolved issues',
  'For example: Review my email subscriptions, identify unused services, and draft cancellation emails',
  'For example: Analyze my Spotify listening history and create a personalized workout playlist based on BPM',
];

export default function ChatInput({
  input,
  handleInputChange,
  handleSubmit,
  isLoading,
  isPreparing,
  disabled,
  rerunAgentDisabled,
  stop,
  hasMessages = false,
  onRerunAgent,
  status = 'ready',
  isSubmitting = false,
}: ChatInputProps) {
  const { isDeveloperMode, toggleDeveloperMode } = useDeveloperModeStore();
  const { selectedModel, setSelectedModel } = useChatStore();
  const userSelectableModels = useUserSelectableModels();
  const { availableCloudProviderModels } = useCloudProvidersStore();
  const { availableTools, selectedToolIds, removeSelectedTool } = useToolsStore();
  const { installedMcpServers } = useMcpServersStore();

  // Rotating placeholder state
  const [placeholderIndex, setPlaceholderIndex] = useState(0);

  // Simple speech recognition state
  const [isListening, setIsListening] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const [audioChunks, setAudioChunks] = useState<Blob[]>([]);

  // Check if media recording is supported (works in Electron)
  const speechSupported = typeof window !== 'undefined' && 'MediaRecorder' in window;

  // Rotate placeholder every 7 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setPlaceholderIndex((prev) => (prev + 1) % PLACEHOLDER_EXAMPLES.length);
    }, 7000);

    return () => clearInterval(interval);
  }, []);

  // Initialize media recorder for audio capture
  useEffect(() => {
    if (speechSupported) {
      // MediaRecorder setup will be done when user clicks microphone
      console.log('MediaRecorder is supported for audio capture');
    }
  }, [speechSupported]);

  // Check if the selected model supports speech (based on AI SDK docs)
  const modelSupportsSpeech = useMemo(() => {
    if (!selectedModel) return false;

    // Only OpenAI models support speech generation via AI SDK
    const speechModels = [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4o-audio'
    ];

    return speechModels.some(model =>
      selectedModel.toLowerCase().includes(model.toLowerCase())
    );
  }, [selectedModel]);

  // Handle voice input toggle
  const handleVoiceToggle = useCallback(async () => {
    if (isListening && mediaRecorder) {
      // Stop recording
      mediaRecorder.stop();
      setIsListening(false);
    } else {
      // Start recording
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        const chunks: Blob[] = [];

        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            chunks.push(event.data);
          }
        };

        recorder.onstop = async () => {
          const audioBlob = new Blob(chunks, { type: 'audio/webm' });
          console.log('Audio recorded, blob size:', audioBlob.size);

          // Show transcribing status
          const transcribingEvent = {
            target: { value: '🔄 Transcribing audio...' },
            currentTarget: { value: '🔄 Transcribing audio...' },
          } as React.ChangeEvent<HTMLTextAreaElement>;
          handleInputChange(transcribingEvent);

          try {
            // Use the backend API to transcribe audio (which will use configured OpenAI provider)
            const formData = new FormData();
            formData.append('audio', audioBlob, 'recording.webm');

            const response = await fetch('http://localhost:54587/api/speech/transcribe', {
              method: 'POST',
              body: formData,
            });

            if (response.ok) {
              const result = await response.json();
              const transcription = result.text || '';

              // Update input with transcribed text
              const syntheticEvent = {
                target: { value: transcription },
                currentTarget: { value: transcription },
              } as React.ChangeEvent<HTMLTextAreaElement>;
              handleInputChange(syntheticEvent);
            } else {
              const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
              throw new Error(errorData.error || `Transcription failed: ${response.status}`);
            }
          } catch (error) {
            console.error('Transcription error:', error);

            // Show error message
            const errorEvent = {
              target: { value: `❌ Transcription failed: ${error instanceof Error ? error.message : 'Unknown error'}\n\nPlease configure OpenAI in Settings → Cloud Providers or type your message manually.` },
              currentTarget: { value: `❌ Transcription failed: ${error instanceof Error ? error.message : 'Unknown error'}\n\nPlease configure OpenAI in Settings → Cloud Providers or type your message manually.` },
            } as React.ChangeEvent<HTMLTextAreaElement>;
            handleInputChange(errorEvent);
          }

          // Stop all tracks
          stream.getTracks().forEach(track => track.stop());
        };

        recorder.start();
        setMediaRecorder(recorder);
        setIsListening(true);
        setAudioChunks([]);

        // Show recording indicator in input
        const syntheticEvent = {
          target: { value: '🎤 Listening... speak now' },
          currentTarget: { value: '🎤 Listening... speak now' },
        } as React.ChangeEvent<HTMLTextAreaElement>;
        handleInputChange(syntheticEvent);

      } catch (error) {
        console.error('Could not access microphone:', error);
        alert('Could not access microphone. Please check permissions.');
      }
    }
  }, [isListening, mediaRecorder, handleInputChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // Only submit if a model is selected and not disabled
        if (!disabled) {
          handleSubmit();
        }
      }
    },
    [handleSubmit, disabled]
  );

  // Helper function to find common prefix
  const findCommonPrefix = (tools: Tool[]): string => {
    if (tools.length === 0) return '';

    const names = tools.map((t) => formatToolName(t.name || t.id));
    if (names.length === 1) return '';

    let prefix = '';
    const minLength = Math.min(...names.map((n) => n.length));

    for (let i = 0; i < minLength; i++) {
      const char = names[0][i];
      if (names.every((name) => name[i] === char)) {
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
    if (
      prefix.length > 0 &&
      names.every((name) => {
        const nextChar = name[prefix.length];
        return (
          !nextChar || nextChar === '_' || nextChar === '-' || nextChar === '.' || nextChar === nextChar.toUpperCase()
        );
      })
    ) {
      return prefix;
    }

    return '';
  };

  // Helper function to check if server is still initializing
  const isServerInitializing = (serverId: string): boolean => {
    const mcpServer = installedMcpServers.find((s) => s.id === serverId);
    if (!mcpServer) return false;
    return (
      mcpServer.state === 'not_created' ||
      mcpServer.state === 'created' ||
      mcpServer.state === 'initializing' ||
      mcpServer.state === 'error'
    );
  };

  // Group selected tools by MCP server with read/write counts
  const groupedTools = useMemo(() => {
    const groups: Record<
      string,
      {
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
        serverId: string;
        isInitializing: boolean;
        serverState?: string;
      }
    > = {};

    Array.from(selectedToolIds).forEach((toolId) => {
      const tool = availableTools.find((t) => t.id === toolId);
      if (tool) {
        const serverName = tool.mcpServerName || 'Unknown';
        const serverId = deconstructToolId(tool.id).serverName;
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
            commonPrefix: '',
            serverId: serverId,
            isInitializing: isServerInitializing(serverId),
            serverState: installedMcpServers.find((s) => s.id === serverId)?.state,
          };
        }
        groups[serverName].tools.push(tool);

        // Categorize based on tool analysis (both read and write flags)
        const isRead = tool.analysis?.is_read || false;
        const isWrite = tool.analysis?.is_write || false;

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

    // Calculate common prefixes for each server and sort tools
    Object.values(groups).forEach((group) => {
      group.commonPrefix = findCommonPrefix(group.tools);

      // Sort each category of tools
      const sortTools = (tools: Tool[]) => {
        return tools.sort((a, b) => {
          const aRead = a.analysis?.is_read ?? false;
          const aWrite = a.analysis?.is_write ?? false;
          const bRead = b.analysis?.is_read ?? false;
          const bWrite = b.analysis?.is_write ?? false;

          const getPriority = (isRead: boolean, isWrite: boolean) => {
            if (isRead && !isWrite) return 0;
            if (isRead && isWrite) return 1;
            if (!isRead && isWrite) return 2;
            return 3;
          };

          const aPriority = getPriority(aRead, aWrite);
          const bPriority = getPriority(bRead, bWrite);

          if (aPriority !== bPriority) {
            return aPriority - bPriority;
          }
          return (a.name || a.id).localeCompare(b.name || b.id);
        });
      };

      group.readOnlyTools = sortTools(group.readOnlyTools);
      group.readWriteTools = sortTools(group.readWriteTools);
      group.writeOnlyTools = sortTools(group.writeOnlyTools);
      group.otherTools = sortTools(group.otherTools);
    });

    return groups;
  }, [selectedToolIds, availableTools, installedMcpServers]);

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
          <div className="p-3 pb-0">
            <div className={cn('flex flex-wrap gap-2')}>
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
                      <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/30 rounded-full border border-muted-foreground/10 group hover:bg-muted/40 transition-colors cursor-default">
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
                          <X className="h-3 w-3 cursor-pointer" />
                        </button>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-md max-h-96 overflow-y-auto p-0">
                      <div className="space-y-2 p-2">
                        {/* Server status indicator if initializing or error */}
                        {(data.isInitializing || data.serverState === 'error') && (
                          <div className="flex items-center gap-2 px-2 py-1.5 bg-muted/50 rounded-md">
                            {data.serverState === 'error' ? (
                              <>
                                <AlertCircle className="h-3 w-3 text-red-500" />
                                <span className="text-xs text-red-500">Server error - check Settings</span>
                              </>
                            ) : (
                              <>
                                <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
                                <span className="text-xs text-muted-foreground">Server initializing...</span>
                              </>
                            )}
                          </div>
                        )}

                        {/* Tool lists (simplified for brevity) */}
                        {data.tools.map((tool) => {
                          const fullName = formatToolName(tool.name || tool.id);
                          const displayName = data.commonPrefix
                            ? fullName.slice(data.commonPrefix.length)
                            : fullName;
                          return (
                            <ToolHoverCard
                              key={tool.id}
                              tool={tool}
                              side="left"
                              align="start"
                              showInstructions={true}
                              instructionText="Click to remove this tool"
                            >
                              <button
                                onClick={() => removeSelectedTool(tool.id)}
                                className="flex items-center gap-2 px-2 py-1.5 hover:bg-muted/50 transition-colors cursor-pointer text-left w-full rounded-sm"
                                type="button"
                              >
                                <div className="w-2 h-2 bg-green-500 rounded-full flex-shrink-0" />
                                <span className="text-xs truncate flex-1">{displayName}</span>
                              </button>
                            </ToolHoverCard>
                          );
                        })}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                );
              })}
              {selectedToolIds.size > 20 && (
                <div className="flex items-center gap-2 px-3 py-1.5 bg-green-500/10 rounded-full border border-green-500/20 group">
                  <span className="text-sm font-medium text-green-600 dark:text-green-400">
                    {selectedToolIds.size} tools connected, it may overwhelm the AI. The next call will disable all
                    tools and enable only those needed for the task.
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
        <div className="relative">
          <AIInputTextarea
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder=""
            disabled={false}
            minHeight={48}
            maxHeight={164}
            className={cn(
              "relative z-10",
              isListening && "bg-gradient-to-r from-red-50/50 to-orange-50/50 dark:from-red-950/20 dark:to-orange-950/20"
            )}
          />

          {/* Recording Animation Overlay */}
          {isListening && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
              <div className="flex items-center gap-3 px-4 py-2 bg-red-500/10 dark:bg-red-500/20 rounded-full border border-red-500/30 backdrop-blur-sm">
                <div className="flex items-center gap-1">
                  {/* Animated voice bars */}
                  {[1, 2, 3, 4, 5].map((bar) => (
                    <div
                      key={bar}
                      className="w-1 bg-red-500 rounded-full animate-pulse"
                      style={{
                        height: '12px',
                        animationDelay: `${bar * 0.1}s`,
                        animationDuration: '0.8s',
                      }}
                    />
                  ))}
                </div>
                <span className="text-sm font-medium text-red-600 dark:text-red-400 animate-pulse">
                  Recording...
                </span>
              </div>
            </div>
          )}

          {!input && !hasMessages && !isListening && (
            <div className="absolute inset-0 flex items-start pointer-events-none overflow-hidden">
              <div className="relative w-full h-full pt-2.5 px-4">
                {PLACEHOLDER_EXAMPLES.map((example, index) => {
                  const isActive = index === placeholderIndex;
                  const isPrevious =
                    index === (placeholderIndex - 1 + PLACEHOLDER_EXAMPLES.length) % PLACEHOLDER_EXAMPLES.length;

                  return (
                    <div
                      key={index}
                      className="absolute inset-x-4 text-muted-foreground"
                      style={{
                        transition: 'all 2s ease-in-out',
                        opacity: isActive ? 1 : 0,
                        transform: isActive ? 'translateY(0px)' : isPrevious ? 'translateY(20px)' : 'translateY(-20px)',
                      }}
                    >
                      <span className="text-sm">{example}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
        <AIInputToolbar>
          <AIInputTools>
            <AIInputModelSelect value={selectedModel} onValueChange={setSelectedModel} disabled={false}>
              <AIInputModelSelectTrigger
                className={!selectedModel ? 'green-shimmer-with-pulse border border-green-500' : ''}
              >
                <AIInputModelSelectValue
                  placeholder="No model selected, choose one!"
                  className={!selectedModel ? 'text-green-600 font-medium' : ''}
                />
              </AIInputModelSelectTrigger>
              <AIInputModelSelectContent>
                {/* Local Ollama Models */}
                {userSelectableModels.length > 0 ? (
                  <>
                    <div className="px-2 py-1.5 text-sm font-semibold text-muted-foreground">Local (best privacy)</div>
                    {userSelectableModels.map((model) => (
                      <AIInputModelSelectItem key={model.model} value={model.model}>
                        {model.name || model.model}
                      </AIInputModelSelectItem>
                    ))}
                  </>
                ) : (
                  <Link
                    to="/llm-providers/ollama"
                    className="block px-2 py-3 text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  >
                    For privacy, set up local models →
                  </Link>
                )}

                {/* Cloud Provider Models */}
                {availableCloudProviderModels.length > 0 ? (
                  <>
                    <div className="px-2 py-1.5 text-sm font-semibold text-muted-foreground">
                      Cloud (best efficiency)
                    </div>
                    {availableCloudProviderModels.map((model) => (
                      <AIInputModelSelectItem key={model.id} value={model.id}>
                        {model.id} ({model.provider})
                      </AIInputModelSelectItem>
                    ))}
                  </>
                ) : (
                  <Link
                    to="/llm-providers/cloud"
                    className="block px-2 py-3 text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  >
                    For efficiency, set up cloud models →
                  </Link>
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
            <ChatTokenUsage />
            {/* SPEECH SUPPORT: Simple microphone button */}
            {speechSupported && modelSupportsSpeech && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <AIInputButton
                    onClick={handleVoiceToggle}
                    className={cn(
                      'transition-all duration-200',
                      isListening && 'bg-red-500/20 animate-pulse'
                    )}
                  >
                    {isListening ? (
                      <MicOff size={16} className="text-red-600 dark:text-red-400" />
                    ) : (
                      <Mic size={16} />
                    )}
                  </AIInputButton>
                </TooltipTrigger>
                <TooltipContent>
                  <span>{isListening ? 'Stop recording' : 'Start voice input'}</span>
                </TooltipContent>
              </Tooltip>
            )}
          </AIInputTools>

          <div className="flex items-center gap-2">
            {isLoading && (
              <div className="flex items-center gap-2 px-2.5 py-1 bg-green-500/10 rounded-full border border-green-500/20 group">
                <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                <span className="text-xs font-medium text-green-600 dark:text-green-400">Streaming</span>
              </div>
            )}

            {isPreparing && (
              <div className="flex items-center gap-2 px-2.5 py-1 bg-blue-500/10 rounded-full border border-blue-500/20 group">
                <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
                <span className="text-xs font-medium text-blue-600 dark:text-blue-400">Preparing</span>
              </div>
            )}

            {hasMessages && onRerunAgent && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <AIInputButton onClick={onRerunAgent} disabled={rerunAgentDisabled} type="button" className="px-3">
                    <RefreshCw size={16} />
                    <span className="ml-1.5 text-sm">Restart Agent</span>
                  </AIInputButton>
                </TooltipTrigger>
                <TooltipContent>
                  <span>Will remove all agent chat history and run the agent again</span>
                </TooltipContent>
              </Tooltip>
            )}
            <AIInputSubmit
              onClick={status === 'streaming' || status === 'submitted' || isSubmitting ? stop : undefined}
              disabled={disabled}
              status={
                isSubmitting
                  ? ChatMessageStatus.Submitted
                  : status === 'submitted'
                    ? ChatMessageStatus.Submitted
                    : status === 'streaming'
                      ? ChatMessageStatus.Streaming
                      : status === 'error'
                        ? ChatMessageStatus.Error
                        : ChatMessageStatus.Ready
              }
            />
          </div>
        </AIInputToolbar>
      </AIInput>
    </TooltipProvider>
  );
}