import { create } from 'zustand';

import { getAvailableTools } from '@ui/lib/clients/archestra/api/gen';
import type { AvailableToolsMap, Tool, ToolChoice } from '@ui/types/tools';

interface ToolsState {
  availableTools: Tool[];
  loadingAvailableTools: boolean;
  errorLoadingAvailableTools: Error | null;

  selectedToolIds: Set<string>;

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

export const useToolsStore = create<ToolsStore>((set, get) => ({
  // State
  availableTools: [],
  loadingAvailableTools: true,
  errorLoadingAvailableTools: null,

  selectedToolIds: new Set(),

  toolChoice: 'auto',

  // Actions
  addSelectedTool: (toolId: string) => {
    set(({ selectedToolIds }) => ({
      selectedToolIds: selectedToolIds.add(toolId),
    }));
  },

  removeSelectedTool: (toolId: string) => {
    set(({ selectedToolIds }) => {
      selectedToolIds.delete(toolId);

      return {
        selectedToolIds,
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
        // Select all tools by default
        const allToolIds = new Set(data.map((tool) => tool.id));
        set({
          availableTools: data,
          selectedToolIds: allToolIds,
        });
      }
    } catch {
      set({ errorLoadingAvailableTools: new Error('Failed to fetch available tools') });
    } finally {
      set({ loadingAvailableTools: false });
    }
  },

  setAvailableTools: (tools: Tool[]) => {
    // Select all tools by default
    const allToolIds = new Set(tools.map((tool) => tool.id));
    set({
      availableTools: tools,
      selectedToolIds: allToolIds,
    });
  },

  getAvailableToolsMap: () => {
    return get().availableTools.reduce((acc, tool) => {
      acc[tool.id] = tool;
      return acc;
    }, {} as AvailableToolsMap);
  },
}));

useToolsStore.getState().fetchAvailableTools();
