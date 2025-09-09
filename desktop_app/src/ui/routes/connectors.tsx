import { createFileRoute } from '@tanstack/react-router';
import { AlertCircle, Filter, Package, Search } from 'lucide-react';
import { useState } from 'react';

import { type LocalMcpServerManifest } from '@ui/catalog_local';
import AlphaDisclaimerMessage from '@ui/components/ConnectorCatalog/AlphaDisclaimerMessage';
import McpServer from '@ui/components/ConnectorCatalog/McpServer';
import McpServerInstallDialog from '@ui/components/ConnectorCatalog/McpServerInstallDialog';
import { Input } from '@ui/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@ui/components/ui/select';
import { ArchestraMcpServerManifest } from '@ui/lib/clients/archestra/catalog/gen';
import { useConnectorCatalogStore, useMcpServersStore } from '@ui/stores';
import { type McpServerUserConfigValues } from '@ui/types';

export const Route = createFileRoute('/connectors')({
  component: ConnectorCatalogPage,
});

function ConnectorCatalogPage() {
  const [selectedServerForInstall, setSelectedServerForInstall] = useState<
    ArchestraMcpServerManifest | LocalMcpServerManifest | null
  >(null);
  const [installDialogOpen, setInstallDialogOpen] = useState(false);

  const {
    connectorCatalog,
    connectorCatalogCategories,
    catalogSearchQuery,
    catalogSelectedCategory,
    catalogHasMore,
    catalogTotalCount,
    loadingConnectorCatalog,
    errorFetchingConnectorCatalog,
    setCatalogSearchQuery,
    setCatalogSelectedCategory,
    loadMoreCatalogServers,
  } = useConnectorCatalogStore();
  const { installedMcpServers, installMcpServer: _installMcpServer, uninstallMcpServer } = useMcpServersStore();

  const installMcpServer = async (
    mcpServer: ArchestraMcpServerManifest | LocalMcpServerManifest,
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
      ...((mcpServer as LocalMcpServerManifest).oauth_config && {
        oauthConfig: (mcpServer as LocalMcpServerManifest).oauth_config,
      }),
      // Include remote_url for remote MCP servers
      ...(mcpServer.remote_url && { remote_url: mcpServer.remote_url }),
    };

    // Add useBrowserAuth flag for internal handling
    if (useBrowserAuth) {
      installData.useBrowserAuth = true;
    }

    _installMcpServer(mcpServer.archestra_config?.oauth?.required || false, installData);
  };

  const handleInstallClick = (mcpServer: ArchestraMcpServerManifest | LocalMcpServerManifest) => {
    // If server has user_config, show the dialog
    if (mcpServer.user_config && Object.keys(mcpServer.user_config).length > 0) {
      setSelectedServerForInstall(mcpServer);
      setInstallDialogOpen(true);
    } else {
      // Otherwise, install directly
      installMcpServer(mcpServer);
    }
  };

  const handleOAuthInstallClick = async (mcpServer: ArchestraMcpServerManifest | LocalMcpServerManifest) => {
    // For OAuth install, skip the config dialog and go straight to OAuth flow
    await installMcpServer(mcpServer);
  };

  const handleBrowserInstallClick = async (mcpServer: ArchestraMcpServerManifest | LocalMcpServerManifest) => {
    // For any server that supports browser-based authentication
    // Directly install with browser auth flag
    await installMcpServer(mcpServer, undefined, true);
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
          <h1 className="text-3xl font-bold">MCP Server Catalog</h1>
          <p className="text-muted-foreground mt-1">
            Browse and install Model Context Protocol servers to extend your AI capabilities
          </p>
        </div>

        <AlphaDisclaimerMessage />

        <div className="flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search servers..."
              value={catalogSearchQuery}
              onChange={(e) => setCatalogSearchQuery(e.target.value)}
              className="pl-10"
            />
          </div>
          <Select value={catalogSelectedCategory} onValueChange={setCatalogSelectedCategory}>
            <SelectTrigger className="w-full sm:w-[200px]">
              <Filter className="h-4 w-4 mr-2" />
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {connectorCatalogCategories.map((category) => (
                <SelectItem key={category} value={category}>
                  {category}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {connectorCatalog.map((connectorCatalogMcpServer) => (
          <McpServer
            key={connectorCatalogMcpServer.name}
            server={connectorCatalogMcpServer}
            onInstallClick={handleInstallClick}
            onOAuthInstallClick={handleOAuthInstallClick}
            onBrowserInstallClick={handleBrowserInstallClick}
            onUninstallClick={uninstallMcpServer}
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

      {/* Install Dialog */}
      <McpServerInstallDialog
        mcpServer={selectedServerForInstall}
        open={installDialogOpen}
        onOpenChange={setInstallDialogOpen}
        onInstall={handleInstallWithConfig}
      />
    </div>
  );
}
