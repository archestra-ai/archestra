import { listen } from '@tauri-apps/api/event';
import { Message as OllamaMessage, ToolCall as OllamaToolCall } from 'ollama/browser';
import { create } from 'zustand';

import type { ToolContext } from '../components/kibo/ai-input';
import type { Chat } from '../lib/api';
import { createChat, deleteChat, getAllChats, getChatById } from '../lib/api';
import { ChatMessage, ToolCallInfo } from '../types';
import { useDeveloperModeStore } from './developer-mode-store';
import { useMCPServersStore } from './mcp-servers-store';
import { useOllamaStore } from './ollama-store';
import { convertOllamaToolNameToServerAndToolName, convertSelectedOrAllToolsToOllamaTools } from './ollama-store/utils';

interface ParsedContent {
  thinking: string;
  response: string;
  isThinkingStreaming: boolean;
}

interface ChatState {
  chats: Chat[];
  currentChatId: number | null;
  chatHistory: ChatMessage[];
  streamingMessageId: string | null;
  abortController: AbortController | null;
  isLoadingChats: boolean;
  isLoadingMessages: boolean;
}

interface ChatActions {
  loadChats: () => Promise<void>;
  createNewChat: () => Promise<void>;
  selectChat: (chatId: number) => Promise<void>;
  deleteCurrentChat: () => Promise<void>;
  sendChatMessage: (message: string, selectedTools?: ToolContext[]) => Promise<void>;
  clearChatHistory: () => void;
  cancelStreaming: () => void;
  updateStreamingMessage: (messageId: string, content: string) => void;
  initializeStore: () => void;
}

type ChatStore = ChatState & ChatActions;

export function checkModelSupportsTools(model: string): boolean {
  return (
    model.includes('functionary') ||
    model.includes('mistral') ||
    model.includes('command') ||
    (model.includes('qwen') && !model.includes('0.6b')) ||
    model.includes('hermes') ||
    model.includes('llama3.1') ||
    model.includes('llama-3.1') ||
    model.includes('phi') ||
    model.includes('granite')
  );
}

export function addCancellationText(content: string): string {
  return content.includes('[Cancelled]') ? content : content + ' [Cancelled]';
}

export function markMessageAsCancelled(message: ChatMessage): ChatMessage {
  return {
    ...message,
    isStreaming: false,
    isToolExecuting: false,
    isThinkingStreaming: false,
    content: addCancellationText(message.content),
  };
}

export function parseThinkingContent(content: string): ParsedContent {
  if (!content) {
    return { thinking: '', response: '', isThinkingStreaming: false };
  }

  const thinkRegex = /<think>([\s\S]*?)<\/think>/g;

  let thinking = '';
  let response = content;
  let isThinkingStreaming = false;

  const completedMatches = [...content.matchAll(thinkRegex)];
  const completedThinking = completedMatches.map((match) => match[1]).join('\n\n');

  let contentWithoutCompleted = content.replace(thinkRegex, '');

  const incompleteMatch = contentWithoutCompleted.match(/<think>([\s\S]*)$/);

  if (incompleteMatch) {
    const incompleteThinking = incompleteMatch[1];
    const beforeIncomplete = contentWithoutCompleted.substring(0, contentWithoutCompleted.indexOf('<think>'));

    thinking = completedThinking ? `${completedThinking}\n\n${incompleteThinking}` : incompleteThinking;
    response = beforeIncomplete.trim();
    isThinkingStreaming = true;
  } else {
    thinking = completedThinking;
    response = contentWithoutCompleted.trim();
    isThinkingStreaming = false;
  }

  return {
    thinking,
    response,
    isThinkingStreaming,
  };
}

const executeToolsAndCollectResults = async (
  toolCalls: OllamaToolCall[],
  ollamaMessages: OllamaMessage[],
  finalMessage: OllamaMessage | null
) => {
  const { executeTool } = useMCPServersStore.getState();

  const toolResults: ToolCallInfo[] = [];
  for (const toolCall of toolCalls) {
    const functionName = toolCall.function.name;
    const args = toolCall.function.arguments;
    const [serverName, toolName] = convertOllamaToolNameToServerAndToolName(functionName);

    try {
      const result = await executeTool(serverName, {
        name: toolName,
        arguments: args,
      });
      const toolResultContent = typeof result === 'string' ? result : JSON.stringify(result);

      toolResults.push({
        id: functionName,
        serverName,
        toolName,
        arguments: args,
        result: toolResultContent,
        status: 'completed',
        executionTime: 0,
        startTime: new Date(),
        endTime: new Date(),
      });

      // Add tool result to conversation
      if (finalMessage) {
        ollamaMessages.push(finalMessage, {
          role: 'tool',
          content: toolResultContent,
        });
      }
    } catch (error) {
      toolResults.push({
        id: functionName,
        serverName,
        toolName,
        arguments: toolCall.function.arguments,
        result: '',
        error: error instanceof Error ? error.message : String(error),
        status: 'error',
        executionTime: 0,
        startTime: new Date(),
        endTime: new Date(),
      });
    }
  }

  return toolResults;
};

export const useChatStore = create<ChatStore>((set, get) => ({
  // State
  chats: [],
  currentChatId: null,
  chatHistory: [],
  streamingMessageId: null,
  abortController: null,
  isLoadingChats: false,
  isLoadingMessages: false,

  // Actions
  loadChats: async () => {
    set({ isLoadingChats: true });
    try {
      const { data } = await getAllChats();
      set({ chats: data || [], isLoadingChats: false });
    } catch (error) {
      console.error('Failed to load chats:', error);
      set({ isLoadingChats: false });
    }
  },

  createNewChat: async () => {
    const { selectedModel } = useOllamaStore.getState();
    try {
      const { data } = await createChat({
        body: {
          llm_provider: 'ollama',
          llm_model: selectedModel,
        },
      });
      if (data) {
        set((state) => ({
          chats: [data, ...state.chats],
          currentChatId: data.id,
          chatHistory: [],
        }));
      }
    } catch (error) {
      console.error('Failed to create chat:', error);
    }
  },

  selectChat: async (chatId: number) => {
    set({ isLoadingMessages: true, currentChatId: chatId });
    try {
      const { data } = await getChatById({ path: { id: chatId } });
      if (data) {
        const messages: ChatMessage[] = data.messages.map((msg) => ({
          id: msg.id.toString(),
          role: msg.role as 'user' | 'assistant' | 'system',
          content: msg.content,
          timestamp: new Date(msg.created_at),
        }));
        set({ chatHistory: messages, isLoadingMessages: false });
      }
    } catch (error) {
      console.error('Failed to load chat messages:', error);
      set({ isLoadingMessages: false });
    }
  },

  deleteCurrentChat: async () => {
    const { currentChatId } = get();
    if (!currentChatId) return;

    try {
      await deleteChat({ path: { id: currentChatId } });
      set((state) => {
        const newChats = state.chats.filter((chat) => chat.id !== currentChatId);
        const newCurrentChatId = newChats.length > 0 ? newChats[0].id : null;
        return {
          chats: newChats,
          currentChatId: newCurrentChatId,
          chatHistory: [],
        };
      });

      if (get().currentChatId) {
        await get().selectChat(get().currentChatId!);
      }
    } catch (error) {
      console.error('Failed to delete chat:', error);
    }
  },

  clearChatHistory: () => {
    set({ chatHistory: [] });
  },

  cancelStreaming: () => {
    try {
      const { abortController, streamingMessageId } = get();
      if (abortController) {
        abortController.abort();
        set({ abortController: null });
      }

      // Reset state immediately
      set({ streamingMessageId: null });

      // Clear any stuck execution states from the currently streaming message
      set((state) => ({
        chatHistory: state.chatHistory.map((msg) =>
          msg.id === streamingMessageId || msg.isStreaming || msg.isToolExecuting
            ? {
                ...msg,
                isStreaming: false,
                isToolExecuting: false,
                isThinkingStreaming: false,
              }
            : msg
        ),
      }));
    } catch (error) {
      // Still reset state even if cancellation failed
      set({ streamingMessageId: null });

      const { streamingMessageId } = get();
      set((state) => ({
        chatHistory: state.chatHistory.map((msg) =>
          msg.id === streamingMessageId || msg.isStreaming || msg.isToolExecuting ? markMessageAsCancelled(msg) : msg
        ),
      }));
    }
  },

  updateStreamingMessage: (messageId: string, content: string) => {
    const parsed = parseThinkingContent(content);
    set((state) => ({
      chatHistory: state.chatHistory.map((msg) =>
        msg.id === messageId && msg.isStreaming
          ? {
              ...msg,
              content: parsed.response,
              thinkingContent: parsed.thinking,
              isThinkingStreaming: parsed.isThinkingStreaming,
            }
          : msg
      ),
    }));
  },

  sendChatMessage: async (message: string, selectedTools?: ToolContext[]) => {
    const { chat, selectedModel } = useOllamaStore.getState();
    const { currentChatId } = get();

    const allTools = useMCPServersStore.getState().allAvailableTools();
    const { isDeveloperMode, systemPrompt } = useDeveloperModeStore.getState();

    if (!message.trim()) {
      return;
    }

    // Create a new chat if none exists
    if (!currentChatId) {
      await get().createNewChat();
      if (!get().currentChatId) {
        console.error('Failed to create chat');
        return;
      }
    }

    const modelSupportsTools = checkModelSupportsTools(selectedModel);
    const hasTools = Object.keys(allTools).length > 0;
    const aiMsgId = (Date.now() + 1).toString();
    const abortController = new AbortController();

    set((state) => ({
      streamingMessageId: aiMsgId,
      abortController,
      chatHistory: [
        ...state.chatHistory,
        {
          id: Date.now().toString(),
          role: 'user',
          content: message,
          timestamp: new Date(),
        },
        {
          id: aiMsgId,
          role: 'assistant',
          content: '',
          thinkingContent: '',
          timestamp: new Date(),
          isStreaming: true,
          isThinkingStreaming: false,
        },
      ],
    }));

    try {
      // Add warning if tools are available but model doesn't support them
      if (hasTools && !modelSupportsTools) {
        set((state) => ({
          chatHistory: [
            ...state.chatHistory,
            {
              id: (Date.now() + Math.random()).toString(),
              role: 'system',
              content: `⚠️ MCP tools are available but ${selectedModel} doesn't support tool calling. Consider using functionary-small-v3.2 or another tool-enabled model.`,
              timestamp: new Date(),
            },
          ],
        }));
      }

      // Prepare chat history for Ollama SDK
      const chatHistory = get().chatHistory.filter((msg) => msg.role === 'user' || msg.role === 'assistant');
      const ollamaMessages: OllamaMessage[] = [];

      // Add system prompt if developer mode is enabled and system prompt exists
      if (isDeveloperMode && systemPrompt.trim()) {
        ollamaMessages.push({ role: 'system', content: systemPrompt.trim() });
      }

      // Add chat history
      ollamaMessages.push(
        ...chatHistory.map((msg) => ({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        })),
        { role: 'user', content: message }
      );

      const ollamaFormattedTools =
        hasTools && modelSupportsTools ? convertSelectedOrAllToolsToOllamaTools(selectedTools, allTools) : [];
      const response = await chat(ollamaMessages, ollamaFormattedTools);

      let accumulatedContent = '';
      let finalMessage: OllamaMessage | null = null;
      const accumulatedToolCalls: OllamaToolCall[] = [];

      // Stream the initial response
      for await (const part of response) {
        if (abortController.signal.aborted) {
          break;
        }

        if (part.message?.content) {
          accumulatedContent += part.message.content;
          get().updateStreamingMessage(aiMsgId, accumulatedContent);
        }

        // Collect tool calls from any streaming chunk
        if (part.message?.tool_calls) {
          accumulatedToolCalls.push(...part.message.tool_calls);
        }

        if (part.done) {
          finalMessage = part.message;
          break;
        }
      }

      // Handle tool calls if present and mark message as executing tools
      if (accumulatedToolCalls.length > 0) {
        set((state) => ({
          chatHistory: state.chatHistory.map((msg) =>
            msg.id === aiMsgId
              ? {
                  ...msg,
                  isToolExecuting: true,
                  content: accumulatedContent,
                }
              : msg
          ),
        }));

        const toolResults = await executeToolsAndCollectResults(accumulatedToolCalls, ollamaMessages, finalMessage);
        set((state) => ({
          chatHistory: state.chatHistory.map((msg) =>
            msg.id === aiMsgId
              ? {
                  ...msg,
                  isToolExecuting: false,
                  toolCalls: toolResults,
                }
              : msg
          ),
        }));

        // Get final response from model after tool execution
        if (toolResults.some((tr) => tr.status === 'completed')) {
          const finalResponse = await chat(ollamaMessages);

          let finalContent = '';
          for await (const part of finalResponse) {
            if (abortController.signal.aborted) {
              break;
            }

            if (part.message?.content) {
              finalContent += part.message.content;
              get().updateStreamingMessage(aiMsgId, accumulatedContent + '\n\n' + finalContent);
            }

            if (part.done) {
              set((state) => ({
                chatHistory: state.chatHistory.map((msg) =>
                  msg.id === aiMsgId
                    ? {
                        ...msg,
                        content: accumulatedContent + '\n\n' + finalContent,
                        isStreaming: false,
                        isThinkingStreaming: false,
                      }
                    : msg
                ),
              }));
              break;
            }
          }
        }
      } else {
        // No tool calls, just finalize the message
        set((state) => ({
          chatHistory: state.chatHistory.map((msg) =>
            msg.id === aiMsgId
              ? {
                  ...msg,
                  isStreaming: false,
                  isThinkingStreaming: false,
                }
              : msg
          ),
        }));
      }

      set({ streamingMessageId: null, abortController: null });
    } catch (error: any) {
      // Handle abort specifically
      if (error.name === 'AbortError' || abortController?.signal.aborted) {
        set((state) => ({
          chatHistory: state.chatHistory.map((msg) => (msg.id === aiMsgId ? markMessageAsCancelled(msg) : msg)),
        }));
      } else {
        set((state) => ({
          chatHistory: state.chatHistory.map((msg) =>
            msg.id === aiMsgId
              ? {
                  ...msg,
                  content: `Error: ${error instanceof Error ? error.message : 'An unknown error occurred'}`,
                  isStreaming: false,
                  isThinkingStreaming: false,
                }
              : msg
          ),
        }));
      }
      set({ streamingMessageId: null, abortController: null });
    }
  },

  initializeStore: () => {
    // Load chats on initialization
    get().loadChats();

    // Listen for chat title updates from the backend
    listen<{ chatId: number; title: string }>('chat-title-updated', (event) => {
      set((state) => ({
        chats: state.chats.map((chat) =>
          chat.id === event.payload.chatId
            ? { ...chat, title: event.payload.title, updated_at: new Date().toISOString() }
            : chat
        ),
      }));
    });
  },
}));

// Initialize the chat store on mount
useChatStore.getState().initializeStore();

// Computed selectors
export const useIsStreaming = () => useChatStore((state) => state.streamingMessageId !== null);
