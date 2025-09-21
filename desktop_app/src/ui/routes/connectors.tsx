import { createFileRoute } from '@tanstack/react-router';
import { AlertCircle, MessageSquare, Package, Plus, Search } from 'lucide-react';
import { useState } from 'react';

import AuthConfirmationDialog from '@ui/components/AuthConfirmationDialog';
import McpServer from '@ui/components/ConnectorCatalog/McpServer';
import McpServerInstallDialog from '@ui/components/ConnectorCatalog/McpServerInstallDialog';
import McpServers from '@ui/components/Settings/McpServers';
import { Card, CardContent, CardHeader } from '@ui/components/ui/card';
import { Input } from '@ui/components/ui/input';
import { ArchestraMcpServerManifest } from '@ui/lib/clients/archestra/catalog/gen';
import { useConnectorCatalogStore, useMcpServersStore } from '@ui/stores';
import { type McpServerUserConfigValues } from '@ui/types';

export const Route = createFileRoute('/connectors')({
  component: ConnectorCatalogPage,
});

function ConnectorCatalogPage() {
  const [selectedServerForInstall, setSelectedServerForInstall] = useState<ArchestraMcpServerManifest | null>(null);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);
  const [oauthConfirmDialogOpen, setOauthConfirmDialogOpen] = useState(false);
  const [pendingOAuthServer, setPendingOAuthServer] = useState<ArchestraMcpServerManifest | null>(null);
  const [pendingBrowserAuth, setPendingBrowserAuth] = useState(false);

  const {
    connectorCatalog,
    catalogSearchQuery,
    catalogHasMore,
    catalogTotalCount,
    loadingConnectorCatalog,
    errorFetchingConnectorCatalog,
    setCatalogSearchQuery,
    loadMoreCatalogServers,
  } = useConnectorCatalogStore();
  const {
    installedMcpServers,
    installMcpServer: _installMcpServer,
    uninstallMcpServer,
    cancelMcpServerInstallation,
  } = useMcpServersStore();

  const installMcpServer = async (
    mcpServer: ArchestraMcpServerManifest,
    userConfigValues?: McpServerUserConfigValues,
    useBrowserAuth: boolean = false
  ) => {
    // Sanitize display name to match validation requirements
    // Only allow letters, numbers, spaces, and dashes
    const sanitizedDisplayName = mcpServer.display_name.replace(/[^A-Za-z0-9\s-]/g, '-');

    const installData: any = {
      id: mcpServer.name,
      displayName: sanitizedDisplayName,
      /**
       * NOTE: TBD.. should we be sending the entire `mcpServer.server` object here? Is there
       * value in persisting that?
       *
       * https://github.com/anthropics/dxt/blob/main/MANIFEST.md#server-configuration
       */
      serverConfig: mcpServer.server,
      userConfigValues: userConfigValues || {},
      // If using browser auth, append -browser to the provider name
      oauthProvider:
        useBrowserAuth && mcpServer.archestra_config?.oauth?.provider
          ? `${mcpServer.archestra_config.oauth.provider}-browser`
          : mcpServer.archestra_config?.oauth?.provider,
      // Include OAuth config from catalog if available (new approach)
      ...(mcpServer.oauth_config && {
        oauthConfig: mcpServer.oauth_config,
      }),
      // Include remote_url for remote MCP servers
      ...(mcpServer.server.type === 'remote' && { remote_url: mcpServer.server.url }),
      // Include archestra_config for browser auth provider lookup
      ...(mcpServer.archestra_config && { archestra_config: mcpServer.archestra_config }),
    };

    // Add useBrowserAuth flag for internal handling
    if (useBrowserAuth) {
      installData.useBrowserAuth = true;
    }

    _installMcpServer(mcpServer.archestra_config?.oauth?.required || false, installData);
  };

  const handleInstallClick = (mcpServer: ArchestraMcpServerManifest) => {
    // If server has user_config, show the dialog
    if (mcpServer.user_config && Object.keys(mcpServer.user_config).length > 0) {
      setSelectedServerForInstall(mcpServer);
      setInstallDialogOpen(true);
    } else {
      // Otherwise, install directly
      installMcpServer(mcpServer);
    }
  };

  const handleOAuthInstallClick = async (mcpServer: ArchestraMcpServerManifest) => {
    // Show OAuth confirmation dialog for all OAuth-based servers (including Remote MCP)
    setPendingOAuthServer(mcpServer);
    setPendingBrowserAuth(false);
    setOauthConfirmDialogOpen(true);
  };

  const handleBrowserInstallClick = async (mcpServer: ArchestraMcpServerManifest) => {
    // Show OAuth confirmation dialog for browser auth
    setPendingOAuthServer(mcpServer);
    setPendingBrowserAuth(true);
    setOauthConfirmDialogOpen(true);
  };

  const handleOAuthConfirm = async () => {
    if (pendingOAuthServer) {
      await installMcpServer(pendingOAuthServer, undefined, pendingBrowserAuth);
      setPendingOAuthServer(null);
      setPendingBrowserAuth(false);
    }
  };

  const handleOAuthCancel = () => {
    setPendingOAuthServer(null);
    setPendingBrowserAuth(false);
  };

  const handleInstallWithConfig = async (config: McpServerUserConfigValues) => {
    if (selectedServerForInstall) {
      await installMcpServer(selectedServerForInstall, config);
      setInstallDialogOpen(false);
      setSelectedServerForInstall(null);
    }
  };

  return (
    <div className="space-y-3">
      {/* Header with search and filters */}
      <div className="space-y-3">
        <div>
          <h1 className="text-3xl font-bold">MCP Сonnectors</h1>
          <p className="text-muted-foreground mt-1">
            MCP Connectors allow AI to access your data. Archestra is able to run hundreds of local MCP servers and
            connect to remote ones.
          </p>
        </div>

        {/* Installed MCP Servers */}
        <div>
          <McpServers />
        </div>

        {/* Catalog Section */}
        <div className="mt-6">
          <h2 className="text-lg font-semibold">Catalog</h2>
          <p className="text-sm text-muted-foreground mt-1 mb-3">
            Our MCP catalog is an open source initiative to categorize and curate servers maintained by the community.
          </p>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search servers..."
            value={catalogSearchQuery}
            onChange={(e) => setCatalogSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>

        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {catalogTotalCount > 0 ? (
              <>
                {connectorCatalog.length} of {catalogTotalCount} servers
              </>
            ) : (
              <>
                {connectorCatalog.length} {connectorCatalog.length === 1 ? 'server' : 'servers'}
              </>
            )}
          </p>
          <p className="text-sm text-muted-foreground">{installedMcpServers.length} installed</p>
        </div>
      </div>

      {/* Catalog Grid */}
      {loadingConnectorCatalog && connectorCatalog.length === 0 && (
        <div className="text-center py-16">
          <Package className="h-12 w-12 mx-auto mb-4 opacity-50 animate-pulse" />
          <p className="text-muted-foreground">Loading server catalog...</p>
        </div>
      )}

      {!errorFetchingConnectorCatalog && !loadingConnectorCatalog && connectorCatalog.length === 0 && (
        <div className="text-center py-16">
          <Search className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p className="text-muted-foreground">No servers found matching your criteria</p>
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {/* Request MCP Server Tile - Always First */}
        <Card
          className="transition-all duration-200 hover:shadow-md border-dashed cursor-pointer group"
          onClick={() => window.electronAPI.openExternal('https://github.com/archestra-ai/archestra/issues')}
        >
          <CardHeader className="p-3 pb-2">
            <div className="space-y-1">
              <div className="grid grid-cols-[auto_1fr] items-center gap-1 max-w-full">
                <Plus className="h-4 w-4 text-muted-foreground group-hover:text-foreground" />
                <h3 className="font-medium text-sm text-muted-foreground group-hover:text-foreground">
                  Request MCP Server
                </h3>
              </div>
              <p className="text-xs text-muted-foreground">
                Can't find the MCP server you need? Request it and we'll add it to the catalog.
              </p>
            </div>
          </CardHeader>
          <CardContent className="p-3 pt-0">
            <div className="flex items-center gap-1 text-xs text-muted-foreground group-hover:text-foreground">
              <MessageSquare className="h-3 w-3" />
              <span>Open GitHub Issue</span>
            </div>
          </CardContent>
        </Card>

        {connectorCatalog.map((connectorCatalogMcpServer) => (
          <McpServer
            key={connectorCatalogMcpServer.name}
            server={connectorCatalogMcpServer}
            onInstallClick={handleInstallClick}
            onOAuthInstallClick={handleOAuthInstallClick}
            onBrowserInstallClick={handleBrowserInstallClick}
            onUninstallClick={uninstallMcpServer}
            onCancelInstallClick={cancelMcpServerInstallation}
          />
        ))}
      </div>

      {/* Error state */}
      {errorFetchingConnectorCatalog && (
        <div className="flex flex-col items-center justify-center py-8 gap-3">
          <AlertCircle className="h-8 w-8 mx-auto mb-2 opacity-50" />
          <p className="text-sm text-destructive">Failed to load servers</p>
          <button onClick={() => loadMoreCatalogServers()} className="text-sm text-primary hover:underline">
            Try again
          </button>
        </div>
      )}

      {/*
        Infinite scroll loader - this is disabled if there is an error fetching the catalog

        otherwise this can result in an infinite loop (aka DDoS 😅)
      */}
      {catalogHasMore && !errorFetchingConnectorCatalog && (
        <div
          ref={(node) => {
            if (!node) return;

            const observer = new IntersectionObserver(
              (entries) => {
                if (entries[0].isIntersecting && !loadingConnectorCatalog && !errorFetchingConnectorCatalog) {
                  loadMoreCatalogServers();
                }
              },
              { threshold: 0.1 }
            );

            observer.observe(node);
            return () => observer.disconnect();
          }}
          className="flex justify-center py-8"
        >
          {loadingConnectorCatalog ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              <span>Loading more servers...</span>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Scroll to load more</p>
          )}
        </div>
      )}
      <McpServerInstallDialog
        mcpServer={selectedServerForInstall}
        open={installDialogOpen}
        onOpenChange={setInstallDialogOpen}
        onInstall={handleInstallWithConfig}
      />
      <AuthConfirmationDialog
        open={oauthConfirmDialogOpen}
        onOpenChange={setOauthConfirmDialogOpen}
        isBrowserAuth={pendingBrowserAuth}
        onConfirm={handleOAuthConfirm}
        onCancel={handleOAuthCancel}
      />
    </div>
  );
}
