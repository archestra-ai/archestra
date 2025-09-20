import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import {
  type WebSocketMessage,
  deselectAllChatTools,
  deselectChatTools,
  getAvailableTools,
  selectChatTools,
} from '@ui/lib/clients/archestra/api/gen';
import websocketService from '@ui/lib/websocket';
import type { Tool } from '@ui/types/tools';

import { useChatStore } from './chat-store';

interface ToolApprovalRequest {
  requestId: string;
  toolId: string;
  toolName: string;
  toolDescription?: string;
  args: Record<string, any>;
  isWrite: boolean;
  sessionId: string;
  chatId: number;
  timestamp: number;
}

interface ApprovalRule {
  toolId: string;
  decision: 'approve_always' | 'decline_always';
  timestamp: number;
}

interface ToolsState {
  availableTools: Tool[];
  loadingAvailableTools: boolean;
  errorLoadingAvailableTools: Error | null;

  selectedToolIds: Set<string>;
  hasInitializedSelection: boolean;

  // Tool approval state
  pendingApprovals: Map<string, ToolApprovalRequest>;
  sessionApprovalRules: Map<string, ApprovalRule>;
  currentApprovalRequest: ToolApprovalRequest | null;
  isApprovalDialogOpen: boolean;
}

interface ToolsActions {
  addSelectedTool: (toolId: string) => void;
  removeSelectedTool: (toolId: string) => void;
  setOnlyTools: (toolIds: string[]) => void;

  fetchAvailableTools: () => void;
  setAvailableTools: (tools: Tool[]) => void;
  mergeAvailableTools: (tools: Tool[]) => void;

  // Tool approval actions
  addPendingApproval: (request: ToolApprovalRequest) => void;
  removePendingApproval: (requestId: string) => void;
  openApprovalDialog: (requestId: string) => void;
  closeApprovalDialog: () => void;
  approveRequest: (requestId: string, alwaysApprove: boolean) => void;
  declineRequest: (requestId: string, alwaysDecline: boolean) => void;
  checkSessionRule: (toolId: string, args?: Record<string, any>) => 'approve' | 'decline' | null;
  clearSessionRules: () => void;
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

      // Tool approval state
      pendingApprovals: new Map(),
      sessionApprovalRules: new Map(),
      currentApprovalRequest: null,
      isApprovalDialogOpen: false,

      // Actions
      addSelectedTool: async (toolId: string) => {
        const currentChat = useChatStore.getState().getCurrentChat();

        set(({ selectedToolIds }) => ({
          selectedToolIds: new Set(selectedToolIds).add(toolId),
        }));

        // Save to backend if we have a current chat
        if (currentChat) {
          try {
            // Just call selectChatTools - backend handles null->explicit conversion
            await selectChatTools({
              path: { id: currentChat.id.toString() },
              body: { toolIds: [toolId] },
            });
          } catch (error) {
            console.error('Failed to save tool selection to backend:', error);
          }
        }
      },

      removeSelectedTool: async (toolId: string) => {
        const currentChat = useChatStore.getState().getCurrentChat();

        set(({ selectedToolIds }) => {
          const newSelectedToolIds = new Set(selectedToolIds);
          newSelectedToolIds.delete(toolId);
          return {
            selectedToolIds: newSelectedToolIds,
          };
        });

        // Save to backend if we have a current chat
        if (currentChat) {
          try {
            // Just call deselectChatTools - backend handles null->explicit conversion
            await deselectChatTools({
              path: { id: currentChat.id.toString() },
              body: { toolIds: [toolId] },
            });
          } catch (error) {
            console.error('Failed to save tool deselection to backend:', error);
          }
        }
      },

      setOnlyTools: async (toolIds: string[]) => {
        const currentChat = useChatStore.getState().getCurrentChat();

        set({ selectedToolIds: new Set(toolIds) });

        // Save to backend if we have a current chat
        if (currentChat) {
          try {
            // First clear all tools
            await deselectAllChatTools({
              path: { id: currentChat.id.toString() },
            });

            // Then select only the specified tools
            if (toolIds.length > 0) {
              await selectChatTools({
                path: { id: currentChat.id.toString() },
                body: { toolIds },
              });
            }
          } catch (error) {
            console.error('Failed to set only specified tools in backend:', error);
          }
        }
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

      mergeAvailableTools: (newTools: Tool[]) => {
        const { availableTools: currentTools } = get();

        // Create the merged array, preserving existing tool objects when unchanged
        const mergedTools = currentTools
          .map((currentTool) => {
            const newTool = newTools.find((t) => t.id === currentTool.id);
            if (!newTool) {
              // Tool was removed
              return null;
            }

            // Check if the tool has actually changed (comparing relevant fields)
            const hasChanged =
              currentTool.name !== newTool.name ||
              currentTool.description !== newTool.description ||
              currentTool.analysis?.status !== newTool.analysis?.status ||
              currentTool.analysis?.is_read !== newTool.analysis?.is_read ||
              currentTool.analysis?.is_write !== newTool.analysis?.is_write;

            // Return the new tool if changed, otherwise keep the existing reference
            return hasChanged ? newTool : currentTool;
          })
          .filter(Boolean) as Tool[];

        // Add any new tools that weren't in the current list
        const newToolIds = new Set(currentTools.map((t) => t.id));
        const addedTools = newTools.filter((t) => !newToolIds.has(t.id));

        const finalTools = [...mergedTools, ...addedTools];

        // Only update if there are actual changes
        if (
          finalTools.length !== currentTools.length ||
          finalTools.some((tool, index) => tool !== currentTools[index])
        ) {
          set({ availableTools: finalTools });
        }
      },

      // Tool approval actions
      addPendingApproval: (request) => {
        set((state) => {
          const newPendingApprovals = new Map(state.pendingApprovals);
          newPendingApprovals.set(request.requestId, request);
          return { pendingApprovals: newPendingApprovals };
        });

        // Auto-open dialog for the new request
        get().openApprovalDialog(request.requestId);
      },

      removePendingApproval: (requestId) => {
        set((state) => {
          const newPendingApprovals = new Map(state.pendingApprovals);
          newPendingApprovals.delete(requestId);
          return { pendingApprovals: newPendingApprovals };
        });
      },

      openApprovalDialog: (requestId) => {
        const request = get().pendingApprovals.get(requestId);
        if (request) {
          set({ currentApprovalRequest: request, isApprovalDialogOpen: true });
        }
      },

      closeApprovalDialog: () => {
        set({ currentApprovalRequest: null, isApprovalDialogOpen: false });
      },

      approveRequest: async (requestId, alwaysApprove) => {
        const request = get().pendingApprovals.get(requestId);
        if (!request) return;

        // Add to session rules if "always approve" is selected
        if (alwaysApprove) {
          set((state) => {
            const newRules = new Map(state.sessionApprovalRules);
            newRules.set(request.toolId, {
              toolId: request.toolId,
              decision: 'approve_always',
              timestamp: Date.now(),
            });
            return { sessionApprovalRules: newRules };
          });
        }

        // Send approval response via WebSocket
        const response: Extract<WebSocketMessage, { type: 'tool-approval-response' }> = {
          type: 'tool-approval-response',
          payload: {
            requestId,
            decision: alwaysApprove ? 'approve_always' : 'approve',
            sessionId: request.sessionId,
          },
        };

        // Send the response (WebSocket service will handle it)
        if (websocketService.isConnected()) {
          websocketService.send(response);
        }

        // Clean up
        get().removePendingApproval(requestId);
        get().closeApprovalDialog();
      },

      declineRequest: async (requestId, alwaysDecline) => {
        const request = get().pendingApprovals.get(requestId);
        if (!request) return;

        // Add to session rules if "always decline" is selected
        if (alwaysDecline) {
          set((state) => {
            const newRules = new Map(state.sessionApprovalRules);
            newRules.set(request.toolId, {
              toolId: request.toolId,
              decision: 'decline_always',
              timestamp: Date.now(),
            });
            return { sessionApprovalRules: newRules };
          });
        }

        // Send decline response via WebSocket
        const response: Extract<WebSocketMessage, { type: 'tool-approval-response' }> = {
          type: 'tool-approval-response',
          payload: {
            requestId,
            decision: 'decline',
            sessionId: request.sessionId,
          },
        };

        // Send the response
        if (websocketService.isConnected()) {
          websocketService.send(response);
        }

        // Clean up
        get().removePendingApproval(requestId);
        get().closeApprovalDialog();
      },

      checkSessionRule: (toolId, args) => {
        const rules = get().sessionApprovalRules;

        // Check for tool-level rule
        const toolRule = rules.get(toolId);
        if (toolRule) {
          return toolRule.decision === 'approve_always' ? 'approve' : 'decline';
        }

        return null;
      },

      clearSessionRules: () => {
        set({ sessionApprovalRules: new Map() });
      },
    }),
    {
      name: 'tools-selection-storage',
      // Only persist the selection state, not the tools data
      partialize: (state) => ({
        selectedToolIds: Array.from(state.selectedToolIds),
        hasInitializedSelection: state.hasInitializedSelection,
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
websocketService.subscribe('tools-updated', async ({ payload }) => {
  // For analysis updates, use merge to preserve scroll position
  // For initial tool discovery or major changes, do a full fetch
  const { availableTools } = useToolsStore.getState();
  const isInitialLoad = availableTools.length === 0;

  if (isInitialLoad || payload.message?.includes('Discovered')) {
    // Full fetch for initial load or when new tools are discovered
    useToolsStore.getState().fetchAvailableTools();
  } else {
    // Merge updates for analysis changes to preserve scroll
    try {
      const { data } = await getAvailableTools();
      if (data) {
        useToolsStore.getState().mergeAvailableTools(data);
      }
    } catch (error) {
      console.error('Failed to fetch tools for merge:', error);
      // Fallback to full fetch on error
      useToolsStore.getState().fetchAvailableTools();
    }
  }
});

// Subscribe to tool analysis progress without refetching
websocketService.subscribe('tool-analysis-progress', ({ payload }) => {
  // Log progress but don't refetch - wait for tools-updated event with actual data
  // The actual tool updates will come through tools-updated event
});

// Subscribe to chat tools selection updates (when enable_tools/disable_tools are called)
websocketService.subscribe('chat-tools-updated', ({ payload }) => {
  const { chatId, selectedTools } = payload;
  const currentChat = useChatStore.getState().getCurrentChat();

  // Only update if it's for the current chat
  if (currentChat && currentChat.id === chatId) {
    const { availableTools } = useToolsStore.getState();

    if (selectedTools === null) {
      // null means all tools are selected
      useToolsStore.setState({
        selectedToolIds: new Set(availableTools.map((tool) => tool.id)),
      });
    } else {
      // Update to the specific set of tools
      useToolsStore.setState({
        selectedToolIds: new Set(selectedTools),
      });
    }
  }
});

// Subscribe to tool approval requests
websocketService.subscribe('tool-approval-request', (message) => {
  const request: ToolApprovalRequest = {
    ...message.payload,
    timestamp: Date.now(),
  };
  useToolsStore.getState().addPendingApproval(request);
});
