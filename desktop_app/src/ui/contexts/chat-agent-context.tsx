import { type ChatStatus, UIMessage } from 'ai';
import { createContext, useContext } from 'react';

import { useChatStore } from '@ui/stores';

import { MultiChatManagerProvider, useMultiChatManager } from './multi-chat-manager';

interface IChatAgentContext {
  messages: UIMessage[];
  setMessages: (msgs: UIMessage[]) => void;
  sendMessage: (args: { text: string }) => void;
  stop: () => void;
  status: ChatStatus;
  regenerate: () => void;
  isLoading: boolean;
  isSubmitting: boolean;
  setIsSubmitting: (b: boolean) => void;
  editingMessageId: string | null;
  editingContent: string;
  setEditingContent: (c: string) => void;
  startEdit: (id: string, content: string) => void;
  cancelEdit: () => void;
  saveEdit: (id: string) => Promise<void>;
  deleteMessage: (id: string) => Promise<void>;
  handleRegenerateMessage: (idx: number) => Promise<void>;
  regeneratingIndex: number | null;
  fullMessagesBackup: UIMessage[];
  currentChatSessionId: string;
  currentChat: any;
  currentChatTitle: string;
  hasTooManyTools: boolean;
  setHasTooManyTools: (b: boolean) => void;
}

const ChatAgentContext = createContext({} as IChatAgentContext);

function ChatAgentContextProvider({ children }: { children: React.ReactNode }) {
  const { getCurrentChat, getCurrentChatTitle } = useChatStore();
  const multiChatManager = useMultiChatManager();

  const currentChat = getCurrentChat();
  const currentChatSessionId = currentChat?.sessionId || '';
  const currentChatTitle = getCurrentChatTitle();
  const currentChatInstance = multiChatManager.getCurrentChatInstance();

  const currentValues: IChatAgentContext = currentChatInstance
    ? {
        ...currentChatInstance,
        currentChatSessionId: currentChatInstance.sessionId,
        currentChat,
        currentChatTitle,
      }
    : {
        messages: [],
        setMessages: () => {},
        sendMessage: () => {},
        stop: () => {},
        status: 'ready',
        regenerate: () => {},
        isLoading: false,
        isSubmitting: false,
        setIsSubmitting: () => {},
        editingMessageId: null,
        editingContent: '',
        setEditingContent: () => {},
        startEdit: () => {},
        cancelEdit: () => {},
        saveEdit: async () => {},
        deleteMessage: async () => {},
        handleRegenerateMessage: async () => {},
        regeneratingIndex: null,
        fullMessagesBackup: [],
        currentChatSessionId: '',
        currentChat: null,
        currentChatTitle: '',
        hasTooManyTools: false,
        setHasTooManyTools: () => {},
      };

  return (
    <ChatAgentContext.Provider
      value={{
        messages: currentValues.messages,
        setMessages: currentValues.setMessages,
        sendMessage: currentValues.sendMessage,
        stop: currentValues.stop,
        status: currentValues.status,
        regenerate: currentValues.regenerate,
        isLoading: currentValues.isLoading,
        isSubmitting: currentValues.isSubmitting,
        setIsSubmitting: currentValues.setIsSubmitting,
        editingMessageId: currentValues.editingMessageId,
        editingContent: currentValues.editingContent,
        setEditingContent: currentValues.setEditingContent,
        startEdit: currentValues.startEdit,
        cancelEdit: currentValues.cancelEdit,
        saveEdit: async (id: string) => {
          if (currentValues.saveEdit) {
            await currentValues.saveEdit(id);
          }
        },
        deleteMessage: async (id: string) => {
          if (currentValues.deleteMessage) {
            await currentValues.deleteMessage(id);
          }
        },
        handleRegenerateMessage: currentValues.handleRegenerateMessage,
        regeneratingIndex: currentValues.regeneratingIndex,
        fullMessagesBackup: currentValues.fullMessagesBackup,
        currentChatSessionId,
        currentChat,
        currentChatTitle,
        hasTooManyTools: currentValues.hasTooManyTools,
        setHasTooManyTools: currentValues.setHasTooManyTools,
      }}
    >
      {children}
    </ChatAgentContext.Provider>
  );
}

export function ChatAgentProvider({ children }: { children: React.ReactNode }) {
  return (
    <MultiChatManagerProvider>
      <ChatAgentContextProvider>{children}</ChatAgentContextProvider>
    </MultiChatManagerProvider>
  );
}

export function useChatAgent(): IChatAgentContext {
  const context = useContext(ChatAgentContext);
  if (!context) throw new Error('useChatAgent must be used within a ChatAgentProvider.');
  return context;
}
