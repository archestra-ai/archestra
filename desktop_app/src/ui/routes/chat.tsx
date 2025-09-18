import { useChat } from '@ai-sdk/react';
import { createFileRoute } from '@tanstack/react-router';
import { DefaultChatTransport, UIMessage } from 'ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import ChatHistory from '@ui/components/Chat/ChatHistory';
import ChatInput from '@ui/components/Chat/ChatInput';
import EmptyChatState from '@ui/components/Chat/EmptyChatState';
import SystemPrompt from '@ui/components/Chat/SystemPrompt';
import config from '@ui/config';
import posthogClient from '@ui/lib/posthog';
import {
  useChatStore,
  useCloudProvidersStore,
  useDeveloperModeStore,
  useMemoryStore,
  useOllamaStore,
  useToolsStore,
} from '@ui/stores';
import { useStatusBarStore } from '@ui/stores/status-bar-store';

import { DEFAULT_ARCHESTRA_TOOLS } from '../../constants';

const {
  archestra: { chatStreamBaseUrl },
  chat: { systemMemoriesMessageId },
} = config;

export const Route = createFileRoute('/chat')({
  component: ChatPage,
});

function ChatPage() {
  const {
    getCurrentChat,
    getCurrentChatTitle,
    saveDraftMessage,
    getDraftMessage,
    clearDraftMessage,
    editingMessageId,
    editingMessageContent,
    startEditMessage,
    cancelEditMessage,
    saveEditMessage,
    deleteMessage,
    setEditingMessageContent,
    updateMessages,
    pendingPrompts,
    setPendingPrompts,
    removePendingPrompt,
  } = useChatStore();
  const { selectedToolIds, setOnlyTools } = useToolsStore();
  const { selectedModel } = useOllamaStore();
  const { availableCloudProviderModels } = useCloudProvidersStore();
  const { setChatInference } = useStatusBarStore();
  const { getSystemPrompt } = useDeveloperModeStore();
  const { memories, isLoading: isLoadingMemories } = useMemoryStore();

  const [regeneratingIndex, setRegeneratingIndex] = useState<number | null>(null);
  const [fullMessagesBackup, setFullMessagesBackup] = useState<UIMessage[]>([]);

  // Track pre-generation loading state (between submission and streaming start)
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionStartTime, setSubmissionStartTime] = useState<number>(Date.now());

  const currentChat = getCurrentChat();
  const currentChatSessionId = currentChat?.sessionId || '';
  const currentChatTitle = getCurrentChatTitle();

  const pendingPrompt = pendingPrompts.get(currentChatSessionId);

  // Get current input from draft messages
  const currentInput = currentChat ? getDraftMessage(currentChat.id) : '';

  // We use useRef because prepareSendMessagesRequest captures values when created.
  // Without ref, switching models/providers wouldn't work - it would always use the old values.
  // The refs let us always get the current selected model and provider values.
  const selectedModelRef = useRef(selectedModel);
  selectedModelRef.current = selectedModel;

  const availableCloudProviderModelsRef = useRef(availableCloudProviderModels);
  availableCloudProviderModelsRef.current = availableCloudProviderModels;

  const selectedToolIdsRef = useRef(selectedToolIds);
  selectedToolIdsRef.current = selectedToolIds;

  const systemPrompt = getSystemPrompt();
  const systemPromptRef = useRef(systemPrompt);
  systemPromptRef.current = systemPrompt;

  const memoriesText = memories.map((m) => `${m.name}: ${m.value}`).join('\n');
  const memoriesUIMessage = useMemo(
    () =>
      (memoriesText
        ? {
            id: systemMemoriesMessageId,
            role: 'system',
            parts: [{ type: 'text', text: `Previous memories loaded:\n${memoriesText}` }],
          }
        : null) as UIMessage | null,
    [memoriesText]
  );

  const transport = useMemo(() => {
    return new DefaultChatTransport({
      api: `${chatStreamBaseUrl}/stream`,
      prepareSendMessagesRequest: ({ id, messages }) => {
        const currentModel = selectedModelRef.current;
        const currentCloudProviderModels = availableCloudProviderModelsRef.current;
        const currentSystemPrompt = systemPromptRef.current;
        const currentChat = getCurrentChat();

        const cloudModel = currentCloudProviderModels.find((m) => m.id === currentModel);
        const provider = cloudModel ? cloudModel.provider : 'ollama';

        // Ensure system-memories message is included if it exists
        let messagesToSend = messages;

        // Prepend system prompt as a system message if it exists
        const messagesWithSystemPrompt = currentSystemPrompt
          ? [
              {
                id: 'system-prompt',
                role: 'system',
                parts: [{ type: 'text', text: currentSystemPrompt }],
              },
              ...messagesToSend,
            ]
          : messagesToSend;

        return {
          body: {
            messages: messagesWithSystemPrompt,
            model: currentModel,
            sessionId: id || currentChatSessionId,
            provider: provider,
            // Include chatId so backend can load chat-specific tools
            chatId: currentChat?.id,
            // Don't send requestedTools - let backend use chat's stored selection
            toolChoice: 'auto', // Always enable tool usage
          },
        };
      },
    });
  }, [currentChatSessionId, getCurrentChat]);

  const { sendMessage, messages, setMessages, stop, status, regenerate } = useChat({
    id: currentChatSessionId || 'temp-id', // use the provided chat ID or a temp ID
    transport,
    onError: (error) => {
      console.error('Chat error:', error);
      // Clear the pending prompt on error
      if (currentChatSessionId) {
        removePendingPrompt(currentChatSessionId);
      }
      // Add error message to the chat display
      const errorText =
        typeof error === 'string' ? error : error.message || 'An error occurred while processing your request.';
      const errorMessage: UIMessage = {
        id: `error-${Date.now()}`,
        role: 'assistant', // Use standard assistant role for errors
        parts: [
          {
            type: 'text',
            text: errorText,
          },
        ],
      };
      // Add the error message to the current messages
      setMessages((prevMessages) => [...prevMessages, errorMessage]);
      // Also save to the store so it persists
      if (currentChat) {
        updateMessages(currentChat.id, [...messages, errorMessage]);
      }
    },
  });

  const chatIsSubmitted = status === 'submitted';
  const chatIsLoading = status === 'streaming';
  const chatHasError = status === 'error';
  const chatIsReady = status === 'ready';

  const isSubmittingDisabled = !currentInput.trim() || chatIsLoading || isSubmitting || !!pendingPrompt;
  const isChatEmpty = messages.length === 0;

  /**
   * When streaming finishes and there is an assistant reply and the second to
   * last message is the same as the pending prompt, remove the pending prompt
   */
  useEffect(() => {
    if (chatIsReady && currentChatSessionId) {
      const secondToLastMessage = messages.at(-2);
      const lastMessage = messages.at(-1);

      const isSecondToLastMessageSameAsPendingPrompt =
        secondToLastMessage?.parts?.[0]?.type === 'text' && secondToLastMessage?.parts?.[0]?.text === pendingPrompt;
      const isLastMessageAssistant = lastMessage?.role === 'assistant';

      if (isLastMessageAssistant && isSecondToLastMessageSameAsPendingPrompt) removePendingPrompt(currentChatSessionId);
    }
  }, [chatIsReady, currentChatSessionId, messages]);

  // Wrapper functions for message editing actions
  const handleSaveEdit = useCallback(
    async (messageId: string) => {
      // Save the updated messages in the zustand store
      const updatedMessages = await saveEditMessage(messageId, messages);
      // Also update local messages state
      setMessages(updatedMessages);
    },
    [messages, saveEditMessage]
  );

  const handleDeleteMessage = useCallback(
    async (messageId: string) => {
      await deleteMessage(messageId, messages);
      // Also update local messages state
      setMessages(messages.filter((msg) => msg.id !== messageId));
    },
    [messages, deleteMessage]
  );

  // Handle regeneration for specific message index
  const handleRegenerateMessage = useCallback(
    async (messageIndex: number) => {
      const messageToRegenerate = messages[messageIndex];

      if (!messageToRegenerate || messageToRegenerate.role !== 'assistant') {
        console.error('Can only regenerate assistant messages');
        return;
      }

      setRegeneratingIndex(messageIndex);

      // Store the full messages array for display purposes
      setFullMessagesBackup(messages);

      // Create a truncated conversation for the API call only
      const conversationUpToAssistant = messages.slice(0, messageIndex + 1);

      // Temporarily set messages to truncated version for API call
      setMessages(conversationUpToAssistant);

      // Use the built-in regenerate function which will regenerate the last assistant message
      regenerate();
    },
    [messages, regenerate]
  );

  // Track inference in StatusBar
  useEffect(() => {
    if (chatIsLoading || isSubmitting) {
      setChatInference(currentChatSessionId, currentChatTitle, true);
    } else if (chatIsReady || chatHasError) {
      // Only stop inference when this specific chat is done
      setChatInference(currentChatSessionId, currentChatTitle, false);
    }
  }, [
    chatIsLoading,
    isSubmitting,
    chatIsReady,
    chatHasError,
    currentChatSessionId,
    currentChatTitle,
    setChatInference,
  ]);

  useEffect(() => {
    if (chatIsLoading) {
      setIsSubmitting(false);
    }
  }, [chatIsLoading]);

  useEffect(() => {
    if (chatIsReady || chatHasError) {
      setIsSubmitting(false);
    }

    // Handle error case during regeneration - restore backup messages
    if (chatHasError && regeneratingIndex !== null && fullMessagesBackup.length > 0) {
      setMessages(fullMessagesBackup);
      setFullMessagesBackup([]);
      setRegeneratingIndex(null);
    }
  }, [chatIsReady, chatHasError, regeneratingIndex, fullMessagesBackup]);

  // Clear regenerating state and merge new message when streaming finishes
  useEffect(() => {
    if (chatIsReady && regeneratingIndex !== null && fullMessagesBackup.length > 0) {
      // Get the new regenerated message (last message in the current truncated array)
      const newRegeneratedMessage = messages[messages.length - 1];

      if (newRegeneratedMessage && regeneratingIndex < fullMessagesBackup.length) {
        // Create new array with the regenerated message replaced
        const updatedMessages = [...fullMessagesBackup];
        updatedMessages[regeneratingIndex] = newRegeneratedMessage;

        // Set the complete updated messages array
        setMessages(updatedMessages);
      } else {
        // Fallback: restore backup if something went wrong
        setMessages(fullMessagesBackup);
      }

      setFullMessagesBackup([]);
      setRegeneratingIndex(null);
    } else if (chatIsReady && regeneratingIndex !== null) {
      // No backup to restore, just clear the regenerating state
      setRegeneratingIndex(null);
    }
  }, [chatIsReady, regeneratingIndex, fullMessagesBackup, messages]);

  // Add a ref to track the last loaded chat
  const lastLoadedChatIdRef = useRef<string | null>(null);

  // Load messages from database when chat changes
  useEffect(() => {
    // Only sync messages when switching to a different chat
    // Don't sync when the same chat object updates (title, tokens, etc.)
    if (currentChatSessionId && currentChatSessionId !== lastLoadedChatIdRef.current) {
      const chat = getCurrentChat();
      if (chat && chat.messages && chat.messages.length > 0) {
        // Messages are already UIMessage type
        setMessages(chat.messages);
      } else {
        // Clear messages when chat exists but has no messages
        setMessages([]);
      }
      lastLoadedChatIdRef.current = currentChatSessionId;
    }
  }, [currentChatSessionId, getCurrentChat]); // Only depend on session ID and the getter function

  // Add debounced message sync from useChat to store
  const messageSyncTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Sync messages back to store with debouncing
    // Only sync when we have a valid chat and messages
    if (currentChat && messages.length > 0 && !chatIsLoading) {
      // Clear existing timeout
      if (messageSyncTimeoutRef.current) {
        clearTimeout(messageSyncTimeoutRef.current);
      }

      // Debounce to avoid excessive updates during streaming
      messageSyncTimeoutRef.current = setTimeout(() => {
        updateMessages(currentChat.id, messages);
      }, 1000); // 1 second debounce
    }

    // Cleanup on unmount
    return () => {
      if (messageSyncTimeoutRef.current) {
        clearTimeout(messageSyncTimeoutRef.current);
      }
    };
  }, [messages, currentChat?.id, chatIsLoading, updateMessages]);

  // Simple debounce implementation
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  const debouncedSaveDraft = useCallback((chatId: number, content: string) => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      // This could be used for future persistence to localStorage or server
      console.log('Debounced save draft:', { chatId, contentLength: content.length });
    }, 500);
  }, []);

  // Cleanup timeout on unmount to prevent memory leak
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      if (currentChat) {
        // Immediately update UI by saving to store without debounce
        saveDraftMessage(currentChat.id, newValue);
        // Also save with debounce for potential future persistence
        debouncedSaveDraft(currentChat.id, newValue);
      }
    },
    [currentChat, saveDraftMessage, debouncedSaveDraft]
  );

  /**
   * Check if more than 20 tools are selected and reset to default if so
   */
  const conditionallyResetTools = useCallback(() => {
    if (selectedToolIds.size > 20) {
      setOnlyTools(DEFAULT_ARCHESTRA_TOOLS);
    }
  }, [selectedToolIds, setOnlyTools]);

  const handleSubmit = useCallback(
    async (e?: React.FormEvent<HTMLFormElement>) => {
      e?.preventDefault();

      if (isSubmittingDisabled) {
        return;
      } else if (currentInput.trim() && currentChat) {
        if (messages.length === 0 && memoriesUIMessage) {
          setMessages([memoriesUIMessage]);
        }

        conditionallyResetTools();

        setIsSubmitting(true);
        setSubmissionStartTime(Date.now());
        sendMessage({ text: currentInput });
        setPendingPrompts(currentChatSessionId, currentInput);
        clearDraftMessage(currentChat.id);

        // Track message sent in PostHog
        posthogClient.capture('message_sent', {
          chatId: currentChat.id,
          messageLength: currentInput.length,
          toolsCount: selectedToolIds.size,
        });
      }
    },
    [
      isSubmittingDisabled,
      currentInput,
      currentChat,
      messages,
      memoriesUIMessage,
      selectedToolIds,
      setMessages,
      conditionallyResetTools,
      sendMessage,
      setPendingPrompts,
      clearDraftMessage,
    ]
  );

  const handlePromptSelect = useCallback(
    async (prompt: string) => {
      conditionallyResetTools();

      setIsSubmitting(true);
      setSubmissionStartTime(Date.now());

      // Directly send the prompt when a tile is clicked
      sendMessage({ text: prompt });

      // Track prompt selection in PostHog
      posthogClient.capture('prompt_selected', {
        chatId: currentChat?.id,
        promptLength: prompt.length,
        toolsCount: selectedToolIds.size,
      });
    },
    [conditionallyResetTools, sendMessage, currentChat, selectedToolIds]
  );

  const handleRerunAgent = useCallback(async () => {
    // Get the first user message (the original prompt)
    const firstUserMessage = messages.find((msg) => msg.role === 'user');

    if (!firstUserMessage) {
      return;
    }

    // Extract text content from the message
    let messageText = '';

    // Check for parts property (AI SDK format)
    if (firstUserMessage.parts) {
      const textPart = firstUserMessage.parts.find((part) => part.type === 'text');
      if (textPart && 'text' in textPart) {
        messageText = textPart.text;
      }
    }

    if (!messageText) {
      return;
    }

    setMessages(memoriesUIMessage ? [memoriesUIMessage] : []);
    conditionallyResetTools();

    // Re-run with the first user message
    setIsSubmitting(true);
    setSubmissionStartTime(Date.now());
    sendMessage({ text: messageText });

    if (currentChat) {
      setPendingPrompts(currentChatSessionId, messageText);
    }
  }, [
    messages,
    memoriesUIMessage,
    currentChatSessionId,
    currentChat,
    conditionallyResetTools,
    setMessages,
    sendMessage,
    setPendingPrompts,
  ]);

  if (!currentChat) {
    return null;
  }

  // Early return if no current chat exists (e.g., during deletion)
  if (!currentChat) {
    return (
      <div className="flex flex-col h-full gap-2 max-w-full overflow-hidden">
        <div className="flex-1 min-h-0 overflow-auto">
          <EmptyChatState onPromptSelect={handlePromptSelect} />
        </div>
        <ChatInput
          input=""
          disabled={true}
          rerunAgentDisabled={true}
          isLoading={false}
          handleInputChange={() => {}}
          handleSubmit={() => {}}
          stop={() => {}}
          hasMessages={false}
          status="ready"
          isSubmitting={false}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full gap-2 max-w-full overflow-hidden">
      {isChatEmpty && !pendingPrompt ? (
        <div className="flex-1 min-h-0 overflow-auto">
          <EmptyChatState onPromptSelect={handlePromptSelect} />
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-hidden max-w-full">
          <ChatHistory
            chatId={currentChat.id}
            pendingPrompt={pendingPrompt}
            sessionId={currentChatSessionId}
            messages={regeneratingIndex !== null && fullMessagesBackup.length > 0 ? fullMessagesBackup : messages}
            editingMessageId={editingMessageId}
            editingContent={editingMessageContent}
            onEditStart={startEditMessage}
            onEditCancel={cancelEditMessage}
            onEditSave={handleSaveEdit}
            onEditChange={setEditingMessageContent}
            onDeleteMessage={handleDeleteMessage}
            onRegenerateMessage={handleRegenerateMessage}
            isRegenerating={regeneratingIndex !== null || chatIsLoading}
            regeneratingIndex={regeneratingIndex}
            isSubmitting={isSubmitting}
            submissionStartTime={submissionStartTime}
          />
        </div>
      )}
      <SystemPrompt />
      <div className="flex-shrink-0">
        <ChatInput
          input={currentInput}
          handleInputChange={handleInputChange}
          handleSubmit={handleSubmit}
          isLoading={chatIsLoading}
          rerunAgentDisabled={chatIsSubmitted || chatIsLoading}
          disabled={isSubmittingDisabled}
          stop={stop}
          hasMessages={messages.length > 0}
          onRerunAgent={handleRerunAgent}
          status={status}
          isSubmitting={isSubmitting}
        />
      </div>
    </div>
  );
}
