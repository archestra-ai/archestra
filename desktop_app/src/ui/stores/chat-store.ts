import { create } from 'zustand';

import config from '@ui/config';
import {
  createChat,
  deleteChat,
  getChatById,
  getChatSelectedTools,
  getChats,
  selectChatTools,
  updateChat,
} from '@ui/lib/clients/archestra/api/gen';
import { initializeChat } from '@ui/lib/utils/chat';
import websocketService from '@ui/lib/websocket';
import { type ChatWithMessages } from '@ui/types';

import { useToolsStore } from './tools-store';

interface ChatState {
  chats: ChatWithMessages[];
  currentChatSessionId: string | null;
  isLoadingChats: boolean;
  draftMessages: Map<number, string>; // chatId -> draft content
}

interface ChatActions {
  loadChats: () => Promise<void>;
  createNewChat: () => Promise<ChatWithMessages>;
  selectChat: (chatId: number) => Promise<void>;
  getCurrentChat: () => ChatWithMessages | null;
  getCurrentChatTitle: () => string;
  deleteCurrentChat: () => Promise<void>;
  updateChatTitle: (chatId: number, title: string) => Promise<void>;
  initializeStore: () => Promise<void>;
  saveDraftMessage: (chatId: number, content: string) => void;
  getDraftMessage: (chatId: number) => string;
  clearDraftMessage: (chatId: number) => void;
}

type ChatStore = ChatState & ChatActions;

/**
 * Listen for chat title updates from the backend via WebSocket
 */
const listenForChatTitleUpdates = () => {
  return websocketService.subscribe('chat-title-updated', (message) => {
    const { chatId, title } = message.payload;
    useChatStore.setState((state) => ({
      chats: state.chats.map((chat) => (chat.id === chatId ? { ...chat, title } : chat)),
    }));
  });
};

export const useChatStore = create<ChatStore>((set, get) => ({
  // State
  chats: [],
  currentChatSessionId: null,
  isLoadingChats: false,
  draftMessages: new Map(),

  // Actions
  loadChats: async () => {
    set({ isLoadingChats: true });
    try {
      const { data } = await getChats();
      if (data && data.length > 0) {
        const initializedChats = data.map(initializeChat);
        set({
          chats: initializedChats,
          currentChatSessionId: initializedChats.length > 0 ? initializedChats[0].sessionId : null,
        });
      } else {
        /**
         * No chats found, create a new one.. there should never be a case where no chat exists..
         */
        await get().createNewChat();
      }
    } catch (error) {
      console.error('Failed to load chats:', error);
    } finally {
      set({ isLoadingChats: false });
    }
  },

  createNewChat: async () => {
    try {
      const { data } = await createChat({
        body: {
          llm_provider: 'ollama',
        },
      });

      // The API client returns { data: ... } wrapper
      if (!data) {
        throw new Error('No data returned from create chat API');
      }

      const initializedChat = initializeChat(data);

      set((state) => ({
        chats: [initializedChat, ...state.chats],
        currentChatSessionId: initializedChat.sessionId,
      }));

      // Save the current tool selection to the new chat
      const toolsStore = useToolsStore.getState();
      if (toolsStore.selectedToolIds.size > 0) {
        // If specific tools are selected, save them to the new chat
        try {
          await selectChatTools({
            path: { id: initializedChat.id.toString() },
            body: { toolIds: Array.from(toolsStore.selectedToolIds) },
          });
        } catch (error) {
          console.error('Failed to save initial tool selection to new chat:', error);
        }
      }
      // If no tools selected or all tools selected, leave as null (default)

      return initializedChat;
    } catch (error) {
      console.error('Failed to create new chat:', error);
      throw error;
    }
  },

  selectChat: async (chatId: number) => {
    try {
      // Fetch the chat with its messages from the API
      const { data } = await getChatById({ path: { id: chatId.toString() } });

      if (data) {
        const initializedChat = initializeChat(data);

        // Update the chat in the store with the fetched data
        set((state) => ({
          chats: state.chats.map((chat) => (chat.id === chatId ? initializedChat : chat)),
          currentChatSessionId: initializedChat.sessionId,
        }));

        // Load and apply the chat's selected tools
        try {
          const { data: toolsData } = await getChatSelectedTools({ path: { id: chatId.toString() } });
          if (toolsData) {
            const toolsStore = useToolsStore.getState();

            // Clear current selection first
            toolsStore.selectedToolIds.clear();

            if (toolsData.selectedTools === null) {
              // null means all tools are selected
              const allToolIds = toolsData.availableTools.map((tool) => tool.id);
              allToolIds.forEach((id) => toolsStore.selectedToolIds.add(id));
            } else if (toolsData.selectedTools.length > 0) {
              // Add only the selected tools
              toolsData.selectedTools.forEach((id) => toolsStore.selectedToolIds.add(id));
            }
            // If selectedTools is empty array, keep the selection empty

            // Trigger a re-render by creating a new Set
            useToolsStore.setState({ selectedToolIds: new Set(toolsStore.selectedToolIds) });
          }
        } catch (toolsError) {
          console.error('Failed to load chat tools:', toolsError);
          // Continue even if tools loading fails
        }
      }
    } catch (error) {
      console.error('Failed to load chat messages:', error);
      // Fall back to just switching without loading messages
      const chat = get().chats.find((c) => c.id === chatId);
      if (chat) {
        set({ currentChatSessionId: chat.sessionId });
      }
    }
  },

  getCurrentChat: () => {
    const { currentChatSessionId, chats } = get();
    return chats.find((chat) => chat.sessionId === currentChatSessionId) || null;
  },

  getCurrentChatTitle: () => {
    const currentChat = get().getCurrentChat();
    return currentChat?.title || config.chat.defaultTitle;
  },

  deleteCurrentChat: async () => {
    const currentChat = get().getCurrentChat();
    if (!currentChat) return;

    try {
      await deleteChat({ path: { id: currentChat.id.toString() } });

      const { chats, draftMessages } = get();
      const newChats = chats.filter((chat) => chat.id !== currentChat.id);

      // Clean up draft message for deleted chat
      const newDrafts = new Map(draftMessages);
      newDrafts.delete(currentChat.id);

      if (newChats.length === 0) {
        /**
         * Remove the deleted chat from the state and then create a new one
         *
         * there should never be a case where no chat exists..
         */
        set({ chats: [], currentChatSessionId: null, draftMessages: newDrafts });

        await get().createNewChat();
      } else {
        set({ chats: newChats, currentChatSessionId: newChats[0].sessionId, draftMessages: newDrafts });
      }
    } catch (error) {
      console.error('Failed to delete chat:', error);
    }
  },

  updateChatTitle: async (chatId: number, title: string) => {
    try {
      await updateChat({
        path: { id: chatId.toString() },
        body: { title },
      });

      set((state) => ({
        chats: state.chats.map((chat) => (chat.id === chatId ? { ...chat, title } : chat)),
      }));
    } catch (error) {
      console.error('Failed to update chat title:', error);
    }
  },

  initializeStore: async () => {
    get().loadChats();

    try {
      listenForChatTitleUpdates();
    } catch (error) {
      console.error('Failed to establish WebSocket connection:', error);
    }
  },

  // Draft message actions
  saveDraftMessage: (chatId: number, content: string) => {
    set((state) => {
      const newDrafts = new Map(state.draftMessages);
      if (content.trim()) {
        newDrafts.set(chatId, content);
      } else {
        newDrafts.delete(chatId);
      }
      return { draftMessages: newDrafts };
    });
  },

  getDraftMessage: (chatId: number) => {
    return get().draftMessages.get(chatId) || '';
  },

  clearDraftMessage: (chatId: number) => {
    set((state) => {
      const newDrafts = new Map(state.draftMessages);
      newDrafts.delete(chatId);
      return { draftMessages: newDrafts };
    });
  },
}));

// Initialize the chat store on mount
useChatStore.getState().initializeStore();
