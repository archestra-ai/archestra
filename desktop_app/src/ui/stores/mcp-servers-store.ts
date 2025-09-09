import { v4 as uuidv4 } from 'uuid';
import { create } from 'zustand';

import {
  type InstallMcpServerData,
  type McpServer,
  getMcpServers,
  installMcpServer,
  startMcpServerOauth,
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
    oauthAccessToken: null,
    oauthRefreshToken: null,
    oauthExpiryDate: null,
    oauthDiscoveryMetadata: null,
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
    const { id } = installData || {};
    try {
      set({
        /**
         * If it is a custom MCP server installation, let's generate a temporary UUID for it
         * (just for UI purposes of tracking state of "MCP server currently being installed")
         */
        installingMcpServerId: id || uuidv4(),
        errorInstallingMcpServer: null,
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
              oauthAccessToken: tokens.access_token,
              oauthRefreshToken: tokens.refresh_token ?? undefined,
              oauthExpiryDate: tokens.expires_at || null,
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
       * If OAuth is required for installation of this MCP server, we start the OAuth flow
       * rather than directly "installing" the MCP server
       */
      if (requiresOAuth) {
        // Show confirmation dialog before starting OAuth flow
        const provider = (installData as any).oauthProvider || 'google';
        const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);
        const serviceDescription = provider === 'slack' ? 'Slack workspace' : 'Gmail account';

        const userConfirmed = window.confirm(
          `You're about to connect ${installData?.displayName || id} to Archestra.\n\n` +
            `This will:\n` +
            `• Open ${providerName}'s authentication page in your browser\n` +
            `• Request permission to access your ${serviceDescription}\n` +
            `• Securely store your credentials in Archestra\n\n` +
            `Do you want to continue?`
        );

        if (!userConfirmed) {
          // User cancelled the OAuth flow
          console.log('User cancelled OAuth flow');
          set({ installingMcpServerId: null });
          return;
        }

        // Start OAuth flow with installation data
        const { data } = await startMcpServerOauth({
          body: {
            catalogName: id || '',
            installData: installData!,
          },
        });

        if (data?.authUrl) {
          // Store the state for OAuth callback
          sessionStorage.setItem('oauth_state', data.state);

          // Open the OAuth URL in the default browser
          console.log('Opening OAuth URL:', data.authUrl);
          window.electronAPI.openExternal(data.authUrl);

          // The OAuth callback will handle the rest of the installation
          // Navigate to the OAuth callback page to wait for completion
          window.location.href = '/oauth-callback';
        }
      } else {
        const { data: newlyInstalledMcpServer, error } = await installMcpServer({ body: installData });

        if (error) {
          set({ errorInstallingMcpServer: error.error || 'Unknown error installing MCP server' });
          return;
        }

        get().addMcpServerToInstalledMcpServers(newlyInstalledMcpServer);
      }
    } catch (error) {
      set({ errorInstallingMcpServer: error as string });
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

      await uninstallMcpServer({
        path: { id: mcpServerId },
      });

      // Remove from MCP servers store
      useMcpServersStore.getState().removeMcpServerFromInstalledMcpServers(mcpServerId);
    } catch (error) {
      set({ errorUninstallingMcpServer: error as string });
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
