import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useRef } from 'react';

import ChatHistory from '@ui/components/Chat/ChatHistory';
import ChatInput from '@ui/components/Chat/ChatInput';
import EmptyChatState from '@ui/components/Chat/EmptyChatState';
import SystemPrompt from '@ui/components/Chat/SystemPrompt';
import config from '@ui/config';
import { useChatAgent } from '@ui/contexts/chat-agent-context';
import { useChatStore, useOllamaStore, useToolsStore } from '@ui/stores';

export const Route = createFileRoute('/chat')({
  component: ChatPage,
});

function ChatPage() {
  const { saveDraftMessage, getDraftMessage, clearDraftMessage } = useChatStore();
  const { setOnlyTools } = useToolsStore();
  const { selectedModel } = useOllamaStore();
  const {
    messages,
    setMessages,
    sendMessage,
    stop,
    isLoading,
    isSubmitting,
    setIsSubmitting,
    editingMessageId,
    editingContent,
    setEditingContent,
    startEdit,
    cancelEdit,
    saveEdit,
    deleteMessage,
    handleRegenerateMessage,
    regeneratingIndex,
    fullMessagesBackup,
    currentChatSessionId,
    currentChat,
    hasTooManyTools,
  } = useChatAgent();

  // Get current input from draft messages
  const currentInput = currentChat ? getDraftMessage(currentChat.id) : '';

  // Simple debounce implementation
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const debouncedSaveDraft = useCallback((chatId: number, content: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
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

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    if (currentChat) {
      saveDraftMessage(currentChat.id, newValue);
      debouncedSaveDraft(currentChat.id, newValue);
    }
  };

  const handleSubmit = async (e?: React.FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    if (isSubmittingDisabled) return;
    if (currentInput.trim() && currentChat) {
      let messageText = currentInput;
      if (hasTooManyTools) {
        setOnlyTools(['archestra__list_available_tools', 'archestra__enable_tools', 'archestra__disable_tools']);
        messageText = `You currently have only list_available_tools and enable_tools enabled. Follow these steps:\n1. Call list_available_tools to see all available tool IDs\n2. Call enable_tools with the specific tool IDs you need, for example: {"toolIds": ["filesystem__read_file", "filesystem__write_file"]}\n3. After enabling the necessary tools, disable Archestra tools using disable_tools.\n4. After, proceed with this task: \n\n${currentInput}`;
      }
      setIsSubmitting(true);
      sendMessage({ text: messageText });
      clearDraftMessage(currentChat.id);
    }
  };

  const handlePromptSelect = async (prompt: string) => {
    setIsSubmitting(true);
    sendMessage({ text: prompt });
  };

  const handleRerunAgent = async () => {
    const firstUserMessage = messages.find((msg) => msg.role === 'user');
    if (!firstUserMessage) return;

    // Extract text from message.parts for rerun logic
    let messageText = '';
    if (firstUserMessage.parts) {
      const textPart = firstUserMessage.parts.find((part) => part.type === 'text');
      if (textPart && 'text' in textPart) {
        messageText = textPart.text;
      }
    }
    if (!messageText) return;

    // Clear all messages except memories (system message)
    const memoriesMessage = messages.find((msg) => msg.id === config.chat.systemMemoriesMessageId);
    const newMessages = memoriesMessage ? [memoriesMessage] : [];

    // Update messages to only show memories
    setMessages(newMessages);

    // Automatically send the first user message again
    setIsSubmitting(true);
    sendMessage({ text: messageText });
  };

  const isSubmittingDisabled =
    !currentInput.trim() || isLoading || isSubmitting || !selectedModel || selectedModel === '';

  const isChatEmpty = messages.length === 0;

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
          isPreparing={false}
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

  const isRegenerating = regeneratingIndex !== null || isLoading;
  const isPreparing = isSubmitting && !isRegenerating;

  return (
    <div className="flex flex-col h-full gap-2 max-w-full overflow-hidden">
      {isChatEmpty ? (
        <div className="flex-1 min-h-0 overflow-auto">
          <EmptyChatState onPromptSelect={handlePromptSelect} />
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-hidden max-w-full">
          <ChatHistory
            chatId={currentChat.id}
            sessionId={currentChatSessionId}
            messages={regeneratingIndex !== null && fullMessagesBackup.length > 0 ? fullMessagesBackup : messages}
            editingMessageId={editingMessageId}
            editingContent={editingContent}
            onEditStart={startEdit}
            onEditCancel={cancelEdit}
            onEditSave={async (messageId: string) => await saveEdit(messageId)}
            onEditChange={setEditingContent}
            onDeleteMessage={async (messageId: string) => await deleteMessage(messageId)}
            onRegenerateMessage={handleRegenerateMessage}
            isRegenerating={isRegenerating}
            regeneratingIndex={regeneratingIndex}
            isSubmitting={isSubmitting}
          />
        </div>
      )}
      <SystemPrompt />
      <div className="flex-shrink-0">
        <ChatInput
          input={currentInput}
          handleInputChange={handleInputChange}
          handleSubmit={handleSubmit}
          isLoading={isLoading}
          isPreparing={isPreparing}
          disabled={isSubmittingDisabled}
          stop={stop}
          hasMessages={messages.length > 0}
          onRerunAgent={handleRerunAgent}
          rerunAgentDisabled={isLoading || isSubmitting}
          isSubmitting={isSubmitting}
        />
      </div>
    </div>
  );
}
