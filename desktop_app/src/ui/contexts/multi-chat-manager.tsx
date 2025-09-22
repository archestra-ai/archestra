import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, UIMessage } from 'ai';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import config from '@ui/config';
import { useMessageActions } from '@ui/hooks/use-message-actions';
import { useChatStore, useCloudProvidersStore, useMemoryStore, useToolsStore } from '@ui/stores';
import { useStatusBarStore } from '@ui/stores/status-bar-store';

const {
  archestra: { chatStreamBaseUrl },
  chat: { systemMemoriesMessageId },
} = config;

interface ChatInstanceState {
  sessionId: string;
  chatId: number;
  title: string;
  messages: UIMessage[];
  status: string;
  isLoading: boolean;
  isSubmitting: boolean;
  editingMessageId: string | null;
  editingContent: string;
  regeneratingIndex: number | null;
  fullMessagesBackup: UIMessage[];
  hasTooManyTools: boolean;
}

interface ChatInstanceActions {
  setMessages: (msgs: UIMessage[]) => void;
  sendMessage: (args: { text: string }) => void;
  stop: () => void;
  regenerate: () => void;
  setIsSubmitting: (b: boolean) => void;
  setEditingContent: (c: string) => void;
  startEdit: (id: string, content: string) => void;
  cancelEdit: () => void;
  saveEdit: (id: string) => Promise<void>;
  deleteMessage: (id: string) => Promise<void>;
  handleRegenerateMessage: (idx: number) => Promise<void>;
  setHasTooManyTools: (b: boolean) => void;
}

export type ChatInstance = ChatInstanceState & ChatInstanceActions;

interface MultiChatManagerContextType {
  getCurrentChatInstance: () => ChatInstance | null;
  getChatInstance: (sessionId: string) => ChatInstance | null;
}

const MultiChatManagerContext = createContext<MultiChatManagerContextType | null>(null);

// Component that manages a single chat instance
function ChatInstanceManager({
  sessionId,
  chatId,
  title,
  onInstanceCreated,
  initialMessages = [],
}: {
  sessionId: string;
  chatId: number;
  title: string;
  onInstanceCreated: (instance: ChatInstance) => void;
  initialMessages?: UIMessage[];
}) {
  const { getCurrentChat, selectedModel } = useChatStore();
  const { selectedToolIds } = useToolsStore();
  const { memories } = useMemoryStore();
  const { availableCloudProviderModels } = useCloudProvidersStore();
  const { setChatInference } = useStatusBarStore();
  const [hasTooManyTools, setHasTooManyTools] = useState(false);

  // Refs for transport
  const selectedModelRef = useRef(selectedModel);
  selectedModelRef.current = selectedModel;
  const availableCloudProviderModelsRef = useRef(availableCloudProviderModels);
  availableCloudProviderModelsRef.current = availableCloudProviderModels;
  const selectedToolIdsRef = useRef(selectedToolIds);
  selectedToolIdsRef.current = selectedToolIds;

  // Memories
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
        const cloudModel = currentCloudProviderModels.find((m) => m.id === currentModel);
        return {
          body: {
            messages,
            model: currentModel,
            sessionId: id || sessionId,
            provider: cloudModel ? cloudModel.provider : 'ollama',
            chatId: chatId,
            toolChoice: 'auto',
          },
        };
      },
    });
  }, [sessionId, chatId, getCurrentChat]);

  // Combine memories message with initial messages
  const messagesWithMemories = useMemo(() => {
    if (memoriesUIMessage && initialMessages.length > 0) {
      // Check if memories message already exists in initial messages
      const hasMemoriesMessage = initialMessages.some((msg) => msg.id === systemMemoriesMessageId);
      if (!hasMemoriesMessage) {
        return [memoriesUIMessage, ...initialMessages];
      }
    } else if (memoriesUIMessage && initialMessages.length === 0) {
      // For new chats, just add memories
      return [memoriesUIMessage];
    }
    return initialMessages;
  }, [memoriesUIMessage, initialMessages]);

  const { sendMessage, messages, setMessages, stop, status, regenerate } = useChat({
    id: sessionId || 'temp-id',
    transport,
    onError: (error) => {
      console.error('Chat error:', error);
    },
    messages: messagesWithMemories,
  });

  // Regeneration logic
  const [regeneratingIndex, setRegeneratingIndex] = useState<number | null>(null);
  const [fullMessagesBackup, setFullMessagesBackup] = useState<UIMessage[]>([]);

  // Submission state
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Message actions
  const { editingMessageId, editingContent, setEditingContent, startEdit, cancelEdit, saveEdit, deleteMessage } =
    useMessageActions({
      messages,
      setMessages,
      sendMessage,
      sessionId: sessionId,
    });

  // Regenerate handler
  const handleRegenerateMessage = async (messageIndex: number) => {
    const messageToRegenerate = messages[messageIndex];
    if (!messageToRegenerate || messageToRegenerate.role !== 'assistant') return;
    setRegeneratingIndex(messageIndex);
    setFullMessagesBackup(messages);
    const conversationUpToAssistant = messages.slice(0, messageIndex + 1);
    setMessages(conversationUpToAssistant);
    regenerate();
  };

  // StatusBar inference
  useEffect(() => {
    if (status === 'streaming' || isSubmitting) {
      setChatInference(sessionId, title, true);
    } else if (status === 'ready' || status === 'error') {
      setChatInference(sessionId, title, false);
    }
  }, [status, isSubmitting, sessionId, title, setChatInference]);

  // Submission state reset
  useEffect(() => {
    if (status === 'streaming') setIsSubmitting(false);
  }, [status]);

  useEffect(() => {
    if (status === 'ready' || status === 'error') setIsSubmitting(false);
    if (status === 'error' && regeneratingIndex !== null && fullMessagesBackup.length > 0) {
      setMessages(fullMessagesBackup);
      setFullMessagesBackup([]);
      setRegeneratingIndex(null);
    }
  }, [status, regeneratingIndex, fullMessagesBackup]);

  // Regeneration merge
  useEffect(() => {
    if (status === 'ready' && regeneratingIndex !== null && fullMessagesBackup.length > 0) {
      const newRegeneratedMessage = messages[messages.length - 1];
      if (newRegeneratedMessage && regeneratingIndex < fullMessagesBackup.length) {
        const updatedMessages = [...fullMessagesBackup];
        updatedMessages[regeneratingIndex] = newRegeneratedMessage;
        setMessages(updatedMessages);
      } else {
        setMessages(fullMessagesBackup);
      }
      setFullMessagesBackup([]);
      setRegeneratingIndex(null);
    } else if (status === 'ready' && regeneratingIndex !== null) {
      setRegeneratingIndex(null);
    }
  }, [status, regeneratingIndex, fullMessagesBackup.length]);

  const isLoading = status === 'streaming';

  // Create instance object with stable references
  const stableActions = useMemo(
    () => ({
      setMessages,
      sendMessage,
      stop,
      regenerate,
      setIsSubmitting,
      setEditingContent,
      startEdit,
      cancelEdit,
      saveEdit,
      deleteMessage,
      handleRegenerateMessage,
      setHasTooManyTools,
    }),
    [
      setMessages,
      sendMessage,
      stop,
      regenerate,
      setIsSubmitting,
      setEditingContent,
      startEdit,
      cancelEdit,
      saveEdit,
      deleteMessage,
      handleRegenerateMessage,
      setHasTooManyTools,
    ]
  );

  const instance: ChatInstance = useMemo(
    () => ({
      sessionId,
      chatId,
      title,
      messages,
      status,
      isLoading,
      isSubmitting,
      editingMessageId,
      editingContent,
      regeneratingIndex,
      fullMessagesBackup,
      hasTooManyTools,
      ...stableActions,
    }),
    [
      sessionId,
      chatId,
      title,
      messages,
      status,
      isLoading,
      isSubmitting,
      editingMessageId,
      editingContent,
      regeneratingIndex,
      fullMessagesBackup,
      hasTooManyTools,
      stableActions,
    ]
  );

  // Notify parent when instance is created/updated
  // Only notify on significant state changes to prevent infinite loops
  const prevStatusRef = useRef<string>(null);
  const prevLoadingRef = useRef<boolean>(null);
  const prevSubmittingRef = useRef<boolean>(null);
  const prevMessagesRef = useRef<UIMessage[]>([]);
  const prevRegeneratingIndexRef = useRef<number | null>(null);
  const prevEditingMessageIdRef = useRef<string | null>(null);
  const prevEditingContentRef = useRef<string>(null);
  const hasNotified = useRef(false);

  useEffect(() => {
    const statusChanged = prevStatusRef.current !== status;
    const loadingChanged = prevLoadingRef.current !== isLoading;
    const submittingChanged = prevSubmittingRef.current !== isSubmitting;
    const isFirstTime = !hasNotified.current;
    const messagesChanged = prevMessagesRef.current !== messages;
    const regeneratingIndexChanged = prevRegeneratingIndexRef.current !== regeneratingIndex;
    const editingMessageIdChanged = prevEditingMessageIdRef.current !== editingMessageId;
    const editingContentChanged = prevEditingContentRef.current !== editingContent;

    if (
      isFirstTime ||
      statusChanged ||
      loadingChanged ||
      submittingChanged ||
      messagesChanged ||
      regeneratingIndexChanged ||
      editingMessageIdChanged ||
      editingContentChanged
    ) {
      prevStatusRef.current = status;
      prevLoadingRef.current = isLoading;
      prevSubmittingRef.current = isSubmitting;
      prevMessagesRef.current = messages;
      prevRegeneratingIndexRef.current = regeneratingIndex;
      prevEditingMessageIdRef.current = editingMessageId;
      prevEditingContentRef.current = editingContent;
      hasNotified.current = true;

      onInstanceCreated(instance);
    }
  }, [
    status,
    isLoading,
    isSubmitting,
    instance,
    onInstanceCreated,
    regeneratingIndex,
    editingMessageId,
    editingContent,
  ]);

  // This component doesn't render anything
  return null;
}

export function MultiChatManagerProvider({ children }: { children: React.ReactNode }) {
  const { getCurrentChat } = useChatStore();
  const [chatInstances, setChatInstances] = useState<Map<string, ChatInstance>>(new Map());
  const [requestedInstances, setRequestedInstances] = useState<Set<string>>(new Set());

  const currentChat = getCurrentChat();
  const currentChatSessionId = currentChat?.sessionId || '';

  useEffect(() => {
    if (currentChatSessionId) {
      setRequestedInstances((prev) => new Set(prev).add(currentChatSessionId));
    }
  }, [currentChatSessionId]);

  const handleInstanceCreated = useCallback(
    (instance: ChatInstance) => {
      setChatInstances((prev) => {
        const existing = prev.get(instance.sessionId);

        // Only update if there's a significant change to prevent unnecessary re-renders
        if (
          !existing ||
          existing.status !== instance.status ||
          existing.isLoading !== instance.isLoading ||
          existing.isSubmitting !== instance.isSubmitting ||
          existing.messages.length !== instance.messages.length ||
          existing.regeneratingIndex !== instance.regeneratingIndex ||
          existing.editingMessageId !== instance.editingMessageId ||
          existing.editingContent !== instance.editingContent
        ) {
          const newMap = new Map(prev);
          newMap.set(instance.sessionId, instance);

          return newMap;
        }

        return prev;
      });
    },
    [currentChatSessionId]
  );

  const getCurrentChatInstance = useCallback(() => {
    return chatInstances.get(currentChatSessionId) || null;
  }, [chatInstances, currentChatSessionId]);

  const getChatInstance = useCallback(
    (sessionId: string) => {
      return chatInstances.get(sessionId) || null;
    },
    [chatInstances]
  );

  return (
    <MultiChatManagerContext.Provider
      value={{
        getCurrentChatInstance,
        getChatInstance,
      }}
    >
      {Array.from(requestedInstances).map((sessionId) => {
        const chat = useChatStore.getState().chats.find((c) => c.sessionId === sessionId);
        if (!chat) return null;

        return (
          <ChatInstanceManager
            key={sessionId}
            sessionId={sessionId}
            chatId={chat.id}
            title={chat.title || ''}
            onInstanceCreated={handleInstanceCreated}
            initialMessages={chat.messages || []}
          />
        );
      })}
      {children}
    </MultiChatManagerContext.Provider>
  );
}

export function useMultiChatManager() {
  const context = useContext(MultiChatManagerContext);
  if (!context) throw new Error('useMultiChatManager must be used within a MultiChatManagerProvider');
  return context;
}
