import { create } from 'zustand';

import {
  type MemoryEntry,
  deleteAllMemories as apiDeleteAllMemories,
  deleteMemory as apiDeleteMemory,
  setMemory as apiSetMemory,
  getAllMemories,
} from '@ui/lib/clients/archestra/api/gen';
import websocketService from '@ui/lib/websocket';

interface MemoryState {
  memories: MemoryEntry[];
  isLoading: boolean;
  isBlinking: boolean;
  error: string | null;
  editingMemory: MemoryEntry | null;
}

interface MemoryActions {
  fetchMemories: () => Promise<void>;
  setMemory: (name: string, value: string) => Promise<void>;
  deleteMemory: (name: string) => Promise<void>;
  clearMemories: () => Promise<void>;
  setEditingMemory: (memory: MemoryEntry | null) => void;
  setBlinking: (blinking: boolean) => void;
  initializeStore: () => void;
}

type MemoryStore = MemoryState & MemoryActions;

/**
 * Listen for memory updates from the backend via WebSocket
 */
const listenForMemoryUpdates = () => {
  return websocketService.subscribe('memory-updated', (message) => {
    const { memories } = message.payload;
    useMemoryStore.setState({
      memories: memories || [],
      isBlinking: true,
    });

    // Stop blinking after 3 seconds
    setTimeout(() => {
      useMemoryStore.setState({ isBlinking: false });
    }, 3000);
  });
};

export const useMemoryStore = create<MemoryStore>((set, get) => ({
  // State
  memories: [],
  isLoading: false,
  isBlinking: false,
  error: null,
  editingMemory: null,

  // Actions
  fetchMemories: async () => {
    set({ isLoading: true, error: null });
    try {
      const response = await getAllMemories();
      if (response.data) {
        set({ memories: response.data.memories });
      }
    } catch (error) {
      console.error('Failed to fetch memories:', error);
      set({ error: 'Failed to load memories' });
    } finally {
      set({ isLoading: false });
    }
  },

  setMemory: async (name: string, value: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await apiSetMemory({
        path: { name },
        body: { value },
      });
      if (response.data) {
        // Refresh memories list
        await get().fetchMemories();
      }
    } catch (error) {
      console.error(`Failed to set memory "${name}":`, error);
      set({ error: `Failed to save memory "${name}"` });
      throw error;
    } finally {
      set({ isLoading: false });
    }
  },

  deleteMemory: async (name: string) => {
    set({ isLoading: true, error: null });
    try {
      await apiDeleteMemory({ path: { name } });
      // Refresh memories list
      await get().fetchMemories();
    } catch (error) {
      console.error(`Failed to delete memory "${name}":`, error);
      set({ error: `Failed to delete memory "${name}"` });
      throw error;
    } finally {
      set({ isLoading: false });
    }
  },

  clearMemories: async () => {
    set({ isLoading: true, error: null });
    try {
      await apiDeleteAllMemories();
      set({ memories: [] });
    } catch (error) {
      console.error('Failed to clear memories:', error);
      set({ error: 'Failed to clear memories' });
      throw error;
    } finally {
      set({ isLoading: false });
    }
  },

  setEditingMemory: (memory: MemoryEntry | null) => {
    set({ editingMemory: memory });
  },

  setBlinking: (blinking: boolean) => {
    set({ isBlinking: blinking });
  },

  initializeStore: () => {
    // Fetch initial memories
    get().fetchMemories();

    // Listen for updates
    try {
      listenForMemoryUpdates();
    } catch (error) {
      console.error('Failed to establish WebSocket connection for memory updates:', error);
    }
  },
}));

// Initialize the memory store on mount
useMemoryStore.getState().initializeStore();
