import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { getAvailableTools } from '@ui/lib/clients/archestra/api/gen';
import websocketService from '@ui/lib/websocket';
import type { AvailableToolsMap, Tool, ToolChoice } from '@ui/types/tools';

interface ToolsState {
  availableTools: Tool[];
  loadingAvailableTools: boolean;
  errorLoadingAvailableTools: Error | null;

  selectedToolIds: Set<string>;
  hasInitializedSelection: boolean;

  toolChoice: ToolChoice;
}

interface ToolsActions {
  addSelectedTool: (toolId: string) => void;
  removeSelectedTool: (toolId: string) => void;

  setToolChoice: (choice: ToolChoice) => void;

  fetchAvailableTools: () => void;
  setAvailableTools: (tools: Tool[]) => void;

  getAvailableToolsMap: () => AvailableToolsMap;
}

type ToolsStore = ToolsState & ToolsActions;

export const useToolsStore = create<ToolsStore>()(
  persist(
    (set, get) => ({
  // State
  availableTools: [],
  loadingAvailableTools: true,
  errorLoadingAvailableTools: null,

  selectedToolIds: new Set(),
  hasInitializedSelection: false,

  toolChoice: 'auto',

  // Actions
  addSelectedTool: (toolId: string) => {
    set(({ selectedToolIds }) => ({
      selectedToolIds: new Set(selectedToolIds).add(toolId),
    }));
  },

  removeSelectedTool: (toolId: string) => {
    set(({ selectedToolIds }) => {
      const newSelectedToolIds = new Set(selectedToolIds);
      newSelectedToolIds.delete(toolId);
      return {
        selectedToolIds: newSelectedToolIds,
      };
    });
  },

  setToolChoice: (choice: 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string }) => {
    set({ toolChoice: choice });
  },

  fetchAvailableTools: async () => {
    set({ loadingAvailableTools: true });

    try {
      const { data } = await getAvailableTools();
      if (data) {
        const { selectedToolIds: currentSelection, hasInitializedSelection } = get();
        // Only auto-select tools on first load, not when user has deselected all
        const shouldAutoSelectAll = !hasInitializedSelection && currentSelection.size === 0;
        const selectedToolIds = shouldAutoSelectAll
          ? new Set(data.map((tool) => tool.id))
          : new Set([...currentSelection].filter((id) => data.some((tool) => tool.id === id)));

        set({
          availableTools: data,
          selectedToolIds,
          hasInitializedSelection: true,
        });
      }
    } catch {
      set({ errorLoadingAvailableTools: new Error('Failed to fetch available tools') });
    } finally {
      set({ loadingAvailableTools: false });
    }
  },

  setAvailableTools: (tools: Tool[]) => {
    const { selectedToolIds: currentSelection, hasInitializedSelection } = get();
    // Only auto-select tools on first load, not when user has deselected all
    const shouldAutoSelectAll = !hasInitializedSelection && currentSelection.size === 0;
    const selectedToolIds = shouldAutoSelectAll
      ? new Set(tools.map((tool) => tool.id))
      : new Set([...currentSelection].filter((id) => tools.some((tool) => tool.id === id)));

    set({
      availableTools: tools,
      selectedToolIds,
      hasInitializedSelection: true,
    });
  },

  getAvailableToolsMap: () => {
    return get().availableTools.reduce((acc, tool) => {
      acc[tool.id] = tool;
      return acc;
    }, {} as AvailableToolsMap);
  },
    }),
    {
      name: 'tools-selection-storage',
      // Only persist the selection state, not the tools data
      partialize: (state) => ({
        selectedToolIds: Array.from(state.selectedToolIds),
        hasInitializedSelection: state.hasInitializedSelection,
        toolChoice: state.toolChoice,
      }),
      // Convert array back to Set on rehydration
      onRehydrateStorage: () => (state) => {
        if (state && state.selectedToolIds) {
          state.selectedToolIds = new Set(state.selectedToolIds as any);
        }
      },
    }
  )
);

// Initial fetch of available tools
useToolsStore.getState().fetchAvailableTools();

// Subscribe to tools updates via WebSocket
websocketService.subscribe('tools-updated', ({ payload }) => {
  console.log('Tools updated for MCP server:', payload.mcpServerId);
  // Refetch available tools when any MCP server's tools are updated
  useToolsStore.getState().fetchAvailableTools();
});
