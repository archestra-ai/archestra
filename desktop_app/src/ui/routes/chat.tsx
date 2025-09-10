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
import { useStatusBarStore } from '@ui/stores/status-bar-store';

export const Route = createFileRoute('/chat')({
  component: ChatPage,
});

function ChatPage() {
  const { getCurrentChat, getCurrentChatTitle } = useChatStore();
  const { selectedToolIds } = useToolsStore();
  const { selectedModel } = useOllamaStore();
  const { availableCloudProviderModels } = useCloudProvidersStore();
  const { setChatInference } = useStatusBarStore();
  const [localInput, setLocalInput] = useState('');

  const currentChat = getCurrentChat();
  const currentChatSessionId = currentChat?.sessionId || '';
  const currentChatMessages = currentChat?.messages || [];
  const currentChatTitle = getCurrentChatTitle();

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
  const [fullMessagesBackup, setFullMessagesBackup] = useState<UIMessage[]>([]);

  // Track pre-generation loading state (between submission and streaming start)
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionStartTime, setSubmissionStartTime] = useState<number>(Date.now());

  // Use the message actions hook
  const { editingMessageId, editingContent, setEditingContent, startEdit, cancelEdit, saveEdit, deleteMessage } =
    useMessageActions({
      messages,
      setMessages,
      sendMessage,
      sessionId: currentChatSessionId,
    });

  // Handle regeneration for specific message index
  const handleRegenerateMessage = async (messageIndex: number) => {
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
  };

  // Track inference in StatusBar
  useEffect(() => {
    console.log(
      'Chat status:',
      status,
      'isSubmitting:',
      isSubmitting,
      'sessionId:',
      currentChatSessionId,
      'title:',
      currentChatTitle
    );
    if (status === 'streaming' || isSubmitting) {
      setChatInference(currentChatSessionId, currentChatTitle, true);
    } else if (status === 'ready' || status === 'error') {
      // Only stop inference when this specific chat is done
      setChatInference(currentChatSessionId, currentChatTitle, false);
    }
  }, [status, isSubmitting, currentChatSessionId, currentChatTitle, setChatInference]);

  useEffect(() => {
    if (isLoading) {
      setIsSubmitting(false);
    }
  }, [isLoading]);

  useEffect(() => {
    if (status === 'ready' || status === 'error') {
      setIsSubmitting(false);
    }

    // Handle error case during regeneration - restore backup messages
    if (status === 'error' && regeneratingIndex !== null && fullMessagesBackup.length > 0) {
      setMessages(fullMessagesBackup);
      setFullMessagesBackup([]);
      setRegeneratingIndex(null);
    }
  }, [status, regeneratingIndex, fullMessagesBackup]);

  // Clear regenerating state and merge new message when streaming finishes
  useEffect(() => {
    if (status === 'ready' && regeneratingIndex !== null && fullMessagesBackup.length > 0) {
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
    } else if (status === 'ready' && regeneratingIndex !== null) {
      // No backup to restore, just clear the regenerating state
      setRegeneratingIndex(null);
    }
  }, [status, regeneratingIndex, fullMessagesBackup, messages]);

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
            messages={regeneratingIndex !== null && fullMessagesBackup.length > 0 ? fullMessagesBackup : messages}
            editingMessageId={editingMessageId}
            editingContent={editingContent}
            onEditStart={startEdit}
            onEditCancel={cancelEdit}
            onEditSave={saveEdit}
            onEditChange={setEditingContent}
            onDeleteMessage={deleteMessage}
            onRegenerateMessage={handleRegenerateMessage}
            isRegenerating={regeneratingIndex !== null || isLoading}
            regeneratingIndex={regeneratingIndex}
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
