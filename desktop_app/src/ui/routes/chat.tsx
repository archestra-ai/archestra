import { useChat } from '@ai-sdk/react';
import { createFileRoute } from '@tanstack/react-router';
import { DefaultChatTransport, UIMessage } from 'ai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import ChatHistory from '@ui/components/Chat/ChatHistory';
import ChatInput from '@ui/components/Chat/ChatInput';
import EmptyChatState from '@ui/components/Chat/EmptyChatState';
import SystemPrompt from '@ui/components/Chat/SystemPrompt';
import config from '@ui/config';
import { useMessageActions } from '@ui/hooks/useMessageActions';
import { getAllMemories } from '@ui/lib/clients/archestra/api/gen';
import { useChatStore, useCloudProvidersStore, useOllamaStore, useToolsStore } from '@ui/stores';
import { useStatusBarStore } from '@ui/stores/status-bar-store';

export const Route = createFileRoute('/chat')({
  component: ChatPage,
});

function ChatPage() {
  const { getCurrentChat, getCurrentChatTitle, saveDraftMessage, getDraftMessage, clearDraftMessage } = useChatStore();
  const { selectedToolIds, setOnlyTools } = useToolsStore();
  const { selectedModel } = useOllamaStore();
  const { availableCloudProviderModels } = useCloudProvidersStore();
  const { setChatInference } = useStatusBarStore();
  const [hasTooManyTools, setHasTooManyTools] = useState(false);
  const [hasLoadedMemories, setHasLoadedMemories] = useState(false);

  const currentChat = getCurrentChat();
  const currentChatSessionId = currentChat?.sessionId || '';
  const currentChatMessages = currentChat?.messages || [];
  const currentChatTitle = getCurrentChatTitle();

  // Get current input from draft messages
  const currentInput = currentChat ? getDraftMessage(currentChat.id) : '';
  
  // Reset memory loading flag when chat changes
  useEffect(() => {
    setHasLoadedMemories(false);
  }, [currentChatSessionId]);

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
        const currentChat = getCurrentChat();

        const cloudModel = currentCloudProviderModels.find((m) => m.id === currentModel);
        const provider = cloudModel ? cloudModel.provider : 'ollama';

        return {
          body: {
            messages,
            model: currentModel || 'llama3.1:8b',
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

  // Simple debounce implementation
  const debounceRef = useRef<NodeJS.Timeout | undefined>();

  const debouncedSaveDraft = useCallback((chatId: number, content: string) => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      // This could be used for future persistence to localStorage or server
      console.log('Debounced save draft:', { chatId, contentLength: content.length });
    }, 500);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    if (currentChat) {
      // Immediately update UI by saving to store without debounce
      saveDraftMessage(currentChat.id, newValue);
      // Also save with debounce for potential future persistence
      debouncedSaveDraft(currentChat.id, newValue);
    }
  };

  const loadMemoriesIfNeeded = async () => {
    // Only load memories for the first message in a chat
    if (messages.length === 0 && !hasLoadedMemories) {
      try {
        const { data } = await getAllMemories();
        if (data && data.memories && data.memories.length > 0) {
          // Format memories as a system message to include in context
          const memoriesText = data.memories
            .map((m) => `${m.name}: ${m.value}`)
            .join('\n');
          
          // Add a system message with the memories
          const systemMessage: UIMessage = {
            id: 'system-memories',
            role: 'system',
            content: `Previous memories loaded:\n${memoriesText}`,
          };
          
          // Prepend the system message to the messages
          setMessages([systemMessage]);
        }
        setHasLoadedMemories(true);
      } catch (error) {
        console.error('Failed to load memories:', error);
        // Continue even if memory loading fails
        setHasLoadedMemories(true);
      }
    }
  };

  const handleSubmit = async (e?: React.FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    if (currentInput.trim() && currentChat) {
      // Load memories before sending the first message
      await loadMemoriesIfNeeded();
      
      let messageText = currentInput;
      
      // If more than 20 tools are selected, adjust the tools and message
      if (hasTooManyTools) {
        // Set only the list_available_tools and enable_tools from Archestra
        await setOnlyTools(['archestra__list_available_tools', 'archestra__enable_tools', 'archestra__disable_tools']);
        
        // Prepend instruction to the message
        messageText = `You currently have only list_available_tools and enable_tools enabled. Follow these steps:
1. Call list_available_tools to see all available tool IDs
2. Call enable_tools with the specific tool IDs you need, for example: {"toolIds": ["filesystem__read_file", "filesystem__write_file"]}
3. After enabling the necessary tools, disable Archestra tools using disable_tools.
4. After, proceed with this task: 

${currentInput}`;
      }
      
      setIsSubmitting(true);
      setSubmissionStartTime(Date.now());
      sendMessage({ text: messageText });
      clearDraftMessage(currentChat.id);
    }
  };

  const handlePromptSelect = async (prompt: string) => {
    // Load memories before sending the first message
    await loadMemoriesIfNeeded();
    
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
          input={currentInput}
          handleInputChange={handleInputChange}
          handleSubmit={handleSubmit}
          isLoading={isLoading}
          isSubmitting={isSubmitting}
          stop={stop}
          onTooManyTools={setHasTooManyTools}
        />
      </div>
    </div>
  );
}
