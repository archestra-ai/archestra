import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';

import {
  type InstallMcpServerData,
  type McpServer,
  getMcpServers,
  installMcpServer,
  installMcpServerWithOauth,
  uninstallMcpServer,
} from '@ui/lib/clients/archestra/api/gen';
import { ConnectedMcpServer } from '@ui/types';

/**
 * NOTE: these are here because the "archestra" MCP server is "injected" into the list of "installed" MCP servers
 * (since it is not actually persisted in the database)
 */
const ARCHESTRA_MCP_SERVER_ID = 'archestra';
const ARCHESTRA_MCP_SERVER_NAME = 'Archestra.ai';

interface McpServersState {
  archestraMcpServer: ConnectedMcpServer;

  installedMcpServers: ConnectedMcpServer[];
  loadingInstalledMcpServers: boolean;
  errorLoadingInstalledMcpServers: string | null;

  installingMcpServerId: string | null;
  errorInstallingMcpServer: string | null;

  uninstallingMcpServerId: string | null;
  errorUninstallingMcpServer: string | null;
}

interface McpServersActions {
  loadInstalledMcpServers: () => Promise<void>;
  addMcpServerToInstalledMcpServers: (mcpServer: McpServer) => void;
  removeMcpServerFromInstalledMcpServers: (mcpServerId: string) => void;

  updateMcpServer: (mcpServerId: string, data: Partial<ConnectedMcpServer>) => void;
  installMcpServer: (requiresOAuth: boolean, installData: InstallMcpServerData['body']) => Promise<void>;
  uninstallMcpServer: (mcpServerId: string) => Promise<void>;
  resetInstalledMcpServers: () => void;
}

type McpServersStore = McpServersState & McpServersActions;

export const useMcpServersStore = create<McpServersStore>((set, get) => ({
  // State
  archestraMcpServer: {
    id: ARCHESTRA_MCP_SERVER_ID,
    name: ARCHESTRA_MCP_SERVER_NAME,
    createdAt: new Date().toISOString(),
    serverConfig: {
      command: '',
      args: [],
      env: {},
    },
    userConfigValues: {},
    oauthTokens: null,
    oauthClientInfo: null,
    oauthServerMetadata: null,
    oauthResourceMetadata: null,
    status: 'installed',
    serverType: 'local',
    remoteUrl: null,
    state: 'initializing',
    startupPercentage: 0,
    message: null,
    error: null,
  },

  installedMcpServers: [],
  loadingInstalledMcpServers: false,
  errorLoadingInstalledMcpServers: null,

  installingMcpServerId: null,
  errorInstallingMcpServer: null,

  uninstallingMcpServerId: null,
  errorUninstallingMcpServer: null,

  // Actions
  loadInstalledMcpServers: async () => {
    set({
      loadingInstalledMcpServers: true,
      errorLoadingInstalledMcpServers: null,
    });

    try {
      const { data } = await getMcpServers();
      if (data) {
        for (const server of data) {
          get().addMcpServerToInstalledMcpServers(server);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      set({ errorLoadingInstalledMcpServers: errorMessage });
    } finally {
      set({ loadingInstalledMcpServers: false });
    }
  },

  addMcpServerToInstalledMcpServers: (mcpServer: McpServer) => {
    set((state) => {
      const newServer: ConnectedMcpServer = {
        ...mcpServer,
        state: 'initializing',
        startupPercentage: 0,
        message: null,
        error: null,
      };

      return {
        installedMcpServers: [...state.installedMcpServers, newServer],
      };
    });
  },

  removeMcpServerFromInstalledMcpServers: (mcpServerId: string) => {
    set((state) => ({
      installedMcpServers: state.installedMcpServers.filter((mcpServer) => mcpServer.id !== mcpServerId),
    }));
  },

  updateMcpServer: (mcpServerId: string, data: Partial<ConnectedMcpServer>) => {
    set((state) => {
      const server = state.installedMcpServers.find((s) => s.id === mcpServerId);
      if (server) {
        return {
          installedMcpServers: state.installedMcpServers.map((s) => (s.id === mcpServerId ? { ...s, ...data } : s)),
        };
      }
      return state;
    });
  },

  installMcpServer: async (requiresOAuth: boolean, installData: InstallMcpServerData['body']) => {
    const { id, displayName } = installData || {};
    const installId = id || uuidv4();

    try {
      set({
        /**
         * If it is a custom MCP server installation, let's generate a temporary UUID for it
         * (just for UI purposes of tracking state of "MCP server currently being installed")
         */
        installingMcpServerId: installId,
        errorInstallingMcpServer: null,
      });

      // Add installation task to StatusBar
      const { useStatusBarStore } = await import('@ui/stores/status-bar-store');
      const statusBarStore = useStatusBarStore.getState();
      statusBarStore.updateTask(`install-${installId}`, {
        id: `install-${installId}`,
        type: 'server',
        title: 'Installing MCP Server',
        description: displayName || id || 'Installing server...',
        status: 'active',
        timestamp: Date.now(),
      });

      // Special handling for browser-based authentication
      const useBrowserAuth = (installData as any).useBrowserAuth;
      if (useBrowserAuth) {
        try {
          // Use the oauthProvider if specified (should be 'slack-browser' for Slack browser auth)
          const provider = (installData as any).oauthProvider || 'slack-browser';

          // Open browser authentication window and get tokens
          const tokens = await window.electronAPI.providerBrowserAuth(provider);

          // Send tokens as OAuth fields for consistent handling
          const { data } = await installMcpServer({
            body: {
              ...installData!,
              oauthTokens: {
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token ?? undefined,
                expires_in: tokens.expires_in ? parseInt(tokens.expires_in, 10) : undefined,
                token_type: tokens.token_type,
                scope: tokens.scope,
              },
            },
          });

          if (data) {
            get().addMcpServerToInstalledMcpServers(data);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          set({ errorInstallingMcpServer: errorMessage });
          throw error;
        } finally {
          set({ installingMcpServerId: null });
        }
        return;
      }

      /**
       * If OAuth is required, use the new simple oauth_install endpoint
       */
      if (requiresOAuth) {
        // Show confirmation dialog before starting OAuth flow

        const userConfirmed = window.confirm(
          `You're about to connect ${installData?.displayName || id} to Archestra.\n\n` +
            `This will:\n` +
            `• Open oauth provider's authentication page in your browser\n` +
            `• Securely store your credentials in Archestra\n\n` +
            `Do you want to continue?`
        );

        if (!userConfirmed) {
          console.log('User cancelled OAuth flow');
          set({ installingMcpServerId: null });
          return;
        }

        try {
          // Check if this is a generic OAuth flow
          const isGenericOAuth = (installData as any).oauthConfig?.generic_oauth;

          if (isGenericOAuth) {
            // Use the generic OAuth start endpoint
            const response = await fetch('/api/mcp_server/start_oauth', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ installData: installData! }),
            });

            if (!response.ok) {
              const errorData = await response.json();
              throw new Error(errorData.error || 'Generic OAuth start failed');
            }

            const result = await response.json();

            // Update the server in our store with oauth_pending status
            if (result.server) {
              const newServer: ConnectedMcpServer = result.server;
              set((state) => ({
                installedMcpServers: [newServer, ...state.installedMcpServers],
                installingMcpServerId: null,
              }));
            }
            return;
          } else {
            // Use the regular MCP OAuth endpoint
            const { data: result, error } = await installMcpServerWithOauth({
              body: {
                installData: installData!,
              },
            });

            if (error) {
              throw new Error(typeof error === 'string' ? error : 'OAuth install failed');
            }

            if (result?.server) {
              get().addMcpServerToInstalledMcpServers(result.server);
            }
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          set({ errorInstallingMcpServer: errorMessage });
        }
      } else {
        const { data: newlyInstalledMcpServer, error } = await installMcpServer({ body: installData });

        if (error) {
          set({ errorInstallingMcpServer: error.error || 'Unknown error installing MCP server' });
          return;
        }

        get().addMcpServerToInstalledMcpServers(newlyInstalledMcpServer);
      }

      // Mark installation as completed in StatusBar
      const { useStatusBarStore: StatusBarStore2 } = await import('@ui/stores/status-bar-store');
      const statusBar2 = StatusBarStore2.getState();
      statusBar2.updateTask(`install-${installId}`, {
        status: 'completed',
        description: 'Installation complete',
      });
      setTimeout(() => statusBar2.removeTask(`install-${installId}`), 2000);
    } catch (error) {
      set({ errorInstallingMcpServer: error as string });

      // Mark installation as failed in StatusBar
      const { useStatusBarStore: StatusBarStore3 } = await import('@ui/stores/status-bar-store');
      const statusBar3 = StatusBarStore3.getState();
      statusBar3.updateTask(`install-${installId}`, {
        status: 'error',
        description: 'Installation failed',
        error: error instanceof Error ? error.message : String(error),
      });
      setTimeout(() => statusBar3.removeTask(`install-${installId}`), 10000);
    } finally {
      set({ installingMcpServerId: null });
    }
  },

  uninstallMcpServer: async (mcpServerId: string) => {
    try {
      set({
        uninstallingMcpServerId: mcpServerId,
        errorUninstallingMcpServer: null,
      });

      // Add uninstallation task to StatusBar
      const { useStatusBarStore: StatusBarStore4 } = await import('@ui/stores/status-bar-store');
      const statusBarStore4 = StatusBarStore4.getState();

      // Get server name if available
      const server = get().installedMcpServers.find((s) => s.id === mcpServerId);
      const serverName = server?.name || server?.id || mcpServerId;

      statusBarStore4.updateTask(`uninstall-${mcpServerId}`, {
        id: `uninstall-${mcpServerId}`,
        type: 'server',
        title: 'Uninstalling MCP Server',
        description: serverName,
        status: 'active',
        timestamp: Date.now(),
      });

      await uninstallMcpServer({
        path: { id: mcpServerId },
      });

      // Remove from MCP servers store
      useMcpServersStore.getState().removeMcpServerFromInstalledMcpServers(mcpServerId);

      // Mark uninstallation as completed
      statusBarStore4.updateTask(`uninstall-${mcpServerId}`, {
        status: 'completed',
        description: 'Uninstalled successfully',
      });
      setTimeout(() => statusBarStore4.removeTask(`uninstall-${mcpServerId}`), 2000);
    } catch (error) {
      set({ errorUninstallingMcpServer: error as string });

      // Mark uninstallation as failed
      const { useStatusBarStore: StatusBarStore5 } = await import('@ui/stores/status-bar-store');
      const statusBarStore5 = StatusBarStore5.getState();
      statusBarStore5.updateTask(`uninstall-${mcpServerId}`, {
        status: 'error',
        description: 'Uninstallation failed',
        error: error instanceof Error ? error.message : String(error),
      });
      setTimeout(() => statusBarStore5.removeTask(`uninstall-${mcpServerId}`), 10000);
    } finally {
      set({ uninstallingMcpServerId: null });
    }
  },

  resetInstalledMcpServers: () => {
    set({
      installedMcpServers: [],
    });
  },
}));

// Initialize data on store creation
useMcpServersStore.getState().loadInstalledMcpServers();
