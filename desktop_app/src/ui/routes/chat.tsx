import { useChat } from '@ai-sdk/react';
import { createFileRoute } from '@tanstack/react-router';
import { DefaultChatTransport, UIMessage } from 'ai';
import { useEffect, useMemo, useRef, useState } from 'react';

import ChatHistory from '@ui/components/Chat/ChatHistory';
import ChatInput from '@ui/components/Chat/ChatInput';
import EmptyChatState from '@ui/components/Chat/EmptyChatState';
import SystemPrompt from '@ui/components/Chat/SystemPrompt';
import config from '@ui/config';
import { useMessageActions } from '@ui/hooks/useMessageActions';
import { useChatStore, useCloudProvidersStore, useOllamaStore, useToolsStore } from '@ui/stores';

export const Route = createFileRoute('/chat')({
  component: ChatPage,
});

function ChatPage() {
  const { getCurrentChat } = useChatStore();
  const { selectedToolIds } = useToolsStore();
  const { selectedModel } = useOllamaStore();
  const { availableCloudProviderModels } = useCloudProvidersStore();
  const [localInput, setLocalInput] = useState('');

  const currentChat = getCurrentChat();
  const currentChatSessionId = currentChat?.sessionId || '';
  const currentChatMessages = currentChat?.messages || [];

  // We use useRef because prepareSendMessagesRequest captures values when created.
  // Without ref, switching models/providers wouldn't work - it would always use the old values.
  // The refs let us always get the current selected model and provider values.
  const selectedModelRef = useRef(selectedModel);
  selectedModelRef.current = selectedModel;

  const availableCloudProviderModelsRef = useRef(availableCloudProviderModels);
  availableCloudProviderModelsRef.current = availableCloudProviderModels;

  const selectedToolIdsRef = useRef(selectedToolIds);
  selectedToolIdsRef.current = selectedToolIds;

  const transport = useMemo(() => {
    const apiEndpoint = `${config.archestra.chatStreamBaseUrl}/stream`;

    return new DefaultChatTransport({
      api: apiEndpoint,
      prepareSendMessagesRequest: ({ id, messages }) => {
        const currentModel = selectedModelRef.current;
        const currentCloudProviderModels = availableCloudProviderModelsRef.current;
        const currentSelectedToolIds = selectedToolIdsRef.current;

        const cloudModel = currentCloudProviderModels.find((m) => m.id === currentModel);
        const provider = cloudModel ? cloudModel.provider : 'ollama';

        return {
          body: {
            messages,
            model: currentModel || 'llama3.1:8b',
            sessionId: id || currentChatSessionId,
            provider: provider,
            // Send selected tools if any, otherwise undefined (backend will use all tools)
            requestedTools: currentSelectedToolIds.size > 0 ? Array.from(currentSelectedToolIds) : undefined,
            toolChoice: 'auto', // Always enable tool usage
          },
        };
      },
    });
  }, [currentChatSessionId]);

  const { sendMessage, messages, setMessages, stop, status, error, regenerate } = useChat({
    id: currentChatSessionId || 'temp-id', // use the provided chat ID or a temp ID
    transport,
    onError: (error) => {
      console.error('Chat error:', error);
    },
  });

  const isLoading = status === 'streaming';
  const [regeneratingIndex, setRegeneratingIndex] = useState<number | null>(null);

  // Track pre-generation loading state (between submission and streaming start)
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionStartTime, setSubmissionStartTime] = useState<number>(Date.now());

  // Use the message actions hook
  const {
    editingMessageId,
    editingContent,
    setEditingContent,
    startEdit,
    cancelEdit,
    saveEdit,
    deleteMessage,
    regenerateMessage: regenerateFromHook,
  } = useMessageActions({
    messages,
    setMessages,
    sendMessage,
    sessionId: currentChatSessionId,
  });

  // Store context for regeneration
  const [regenerationContext, setRegenerationContext] = useState<{
    index: number;
    followingMessages: UIMessage[];
    messagesBeforeTarget: UIMessage[];
  } | null>(null);

  // Custom regenerate that keeps following messages
  const handleRegenerateMessage = async (messageIndex: number) => {
    if (messageIndex < 0 || messageIndex >= messages.length) return;

    const messageToRegenerate = messages[messageIndex];
    if (messageToRegenerate.role !== 'assistant') return;

    setRegeneratingIndex(messageIndex);

    // Store the context for regeneration
    const messagesBeforeTarget = messages.slice(0, messageIndex);
    const followingMessages = messages.slice(messageIndex + 1);

    setRegenerationContext({
      index: messageIndex,
      followingMessages,
      messagesBeforeTarget,
    });

    // Set messages to only include up to (but not including) the assistant message to regenerate
    // This will make the last message a user message, which allows regenerate() to work
    setMessages(messagesBeforeTarget);

    // Small delay to ensure state updates are processed
    setTimeout(() => {
      regenerate();
    }, 50);
  };

  // Track if we've already processed the reordering
  const [hasReordered, setHasReordered] = useState(false);

  useEffect(() => {
    if (isLoading) {
      setIsSubmitting(false);
    }
  }, [isLoading]);

  useEffect(() => {
    if (status === 'ready' || status === 'error') {
      setIsSubmitting(false);
    }
  }, [status]);

  // Watch for new assistant message and restore order
  useEffect(() => {
    if (!regenerationContext || status !== 'ready' || hasReordered) return;

    // Check if a new assistant message was added at the end
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === 'assistant' && messages.length > regenerationContext.messagesBeforeTarget.length) {
      // Mark that we're reordering to prevent duplicate processing
      setHasReordered(true);

      // We have a new assistant message, now reorder
      setTimeout(() => {
        setMessages((currentMessages) => {
          const newAssistantMessage = currentMessages[currentMessages.length - 1];

          // Build the correctly ordered message array
          const reorderedMessages = [
            ...regenerationContext.messagesBeforeTarget,
            newAssistantMessage,
            ...regenerationContext.followingMessages,
          ];

          return reorderedMessages;
        });

        // Clear regeneration state
        setRegenerationContext(null);
        setRegeneratingIndex(null);
        setHasReordered(false);
      }, 50);
    }
  }, [messages, status, regenerationContext, hasReordered]);

  // Load messages from database when chat changes
  useEffect(() => {
    if (currentChatMessages && currentChatMessages.length > 0) {
      // Messages are already UIMessage type
      setMessages(currentChatMessages);
    } else {
      // Clear messages when no chat or empty chat
      setMessages([]);
    }
  }, [currentChatSessionId]); // Only depend on session ID to avoid infinite loop

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setLocalInput(e.target.value);
  };

  const handleSubmit = (e?: React.FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    if (localInput.trim()) {
      setIsSubmitting(true);
      setSubmissionStartTime(Date.now());
      sendMessage({ text: localInput });
      setLocalInput('');
    }
  };

  const handlePromptSelect = (prompt: string) => {
    setIsSubmitting(true);
    setSubmissionStartTime(Date.now());
    // Directly send the prompt when a tile is clicked
    sendMessage({ text: prompt });
  };

  if (!currentChat) {
    // TODO: this is a temporary solution, maybe let's make some cool loading animations with a mascot?
    return null;
  }

  // Check if the chat is empty (no messages)
  const isChatEmpty = messages.length === 0;

  return (
    <div className="flex flex-col h-full gap-2 max-w-full overflow-hidden">
      {isChatEmpty ? (
        <div className="flex-1 min-h-0 overflow-auto">
          <EmptyChatState onPromptSelect={handlePromptSelect} />
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-hidden max-w-full">
          <ChatHistory
            messages={messages}
            editingMessageId={editingMessageId}
            editingContent={editingContent}
            onEditStart={startEdit}
            onEditCancel={cancelEdit}
            onEditSave={saveEdit}
            onEditChange={setEditingContent}
            onDeleteMessage={deleteMessage}
            onRegenerateMessage={handleRegenerateMessage}
            isRegenerating={regeneratingIndex !== null || isLoading}
            isSubmitting={isSubmitting}
            submissionStartTime={submissionStartTime}
          />
        </div>
      )}

      <SystemPrompt />
      <div className="flex-shrink-0">
        <ChatInput
          input={localInput}
          handleInputChange={handleInputChange}
          handleSubmit={handleSubmit}
          isLoading={isLoading}
          isSubmitting={isSubmitting}
          stop={stop}
        />
      </div>
    </div>
  );
}
