import { create } from 'zustand';

import { type SandboxStatusSummary as SandboxStatusSummaryWebSocketPayload } from '@ui/lib/clients/archestra/api/gen';
import websocketService from '@ui/lib/websocket';

import { useMcpServersStore } from './mcp-servers-store';
import { useToolsStore } from './tools-store';

type SandboxStatusSummary = Omit<SandboxStatusSummaryWebSocketPayload, 'mcpServers'>;

interface SandboxState {
  statusSummary: SandboxStatusSummary;
  isRunning: boolean;
}

interface SandboxActions {
  _updateStateFromStatusSummary: (statusSummary: SandboxStatusSummaryWebSocketPayload) => void;
}

type SandboxStore = SandboxState & SandboxActions;

export const useSandboxStore = create<SandboxStore>((set, _get) => ({
  // Initial state
  isRunning: false,
  statusSummary: {
    status: 'not_installed',
    runtime: {
      startupPercentage: 0,
      startupMessage: null,
      startupError: null,
    },
  },

  _updateStateFromStatusSummary: (payload: SandboxStatusSummaryWebSocketPayload) => {
    const { updateMcpServer, installedMcpServers } = useMcpServersStore.getState();
    const { setAvailableTools } = useToolsStore.getState();

    const { mcpServers: sandboxedMcpServers, allAvailableTools: aggregatedTools, ...statusSummary } = payload as any;

    set({
      statusSummary,
      isRunning: statusSummary.status === 'running',
    });

    /**
     * Updates two things:
     * 1. MCP server statuses based on the latest update we just received
     * 2. Available tools
     */
    // Use aggregated tools if available (includes Archestra tools), otherwise fall back to sandboxed tools only
    const allAvailableTools =
      aggregatedTools ||
      Object.entries(sandboxedMcpServers).flatMap(([_mcpServerId, server]) => (server as any).tools || []);
    setAvailableTools(allAvailableTools);

    // Track which servers have been updated from the sandbox
    const updatedServerIds = new Set<string>();

    // Update servers that are in the sandbox
    Object.entries(sandboxedMcpServers).forEach(([mcpServerId, server]) => {
      updateMcpServer(mcpServerId, (server as any).container);
      updatedServerIds.add(mcpServerId);
    });

    // For any installed servers not in the sandbox, set them to 'not_created' state
    // This prevents them from being stuck in 'initializing' state
    installedMcpServers.forEach((server) => {
      if (!updatedServerIds.has(server.id)) {
        updateMcpServer(server.id, {
          state: 'not_created',
          startupPercentage: 0,
          message: 'Server not started',
          error: null,
        });
      }
    });
  },
}));

// WebSocket event subscriptions
let unsubscribers: Array<() => void> = [];

const subscribeToWebSocketEvents = () => {
  unsubscribers.push(
    websocketService.subscribe('sandbox-status-update', ({ payload }) => {
      useSandboxStore.getState()._updateStateFromStatusSummary(payload);
    })
  );
};

// Initialize WebSocket subscriptions when the store is created
subscribeToWebSocketEvents();

// Cleanup on window unload
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  });
}
