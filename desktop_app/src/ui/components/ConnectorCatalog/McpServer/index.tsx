import {
  CheckCircle,
  Clock,
  Code,
  Database,
  FileText,
  Globe,
  Info,
  Loader2,
  MessageSquare,
  Package,
  Search,
  Settings,
  Star,
  Users,
} from 'lucide-react';

import ReportIssueWithCatalogEntry from '@ui/components/ReportIssueWithCatalogEntry';
import { Badge } from '@ui/components/ui/badge';
import { Button } from '@ui/components/ui/button';
import { Card, CardContent, CardHeader } from '@ui/components/ui/card';
import { ArchestraMcpServerManifest } from '@ui/lib/clients/archestra/catalog/gen';
import { useMcpServersStore, useSandboxStore } from '@ui/stores';

interface McpServerProps {
  server: ArchestraMcpServerManifest;
  onInstallClick: (server: ArchestraMcpServerManifest) => void;
  onOAuthInstallClick?: (server: ArchestraMcpServerManifest) => void;
  onBrowserInstallClick?: (server: ArchestraMcpServerManifest) => void;
  onUninstallClick: (serverId: string) => void;
  onCancelInstallClick?: (serverId: string) => void;
}

export default function McpServer({
  server,
  onInstallClick,
  onOAuthInstallClick,
  onBrowserInstallClick,
  onUninstallClick,
  onCancelInstallClick,
}: McpServerProps) {
  const { installedMcpServers, installingMcpServerId, uninstallingMcpServerId } = useMcpServersStore();
  const { isRunning: sandboxIsRunning } = useSandboxStore();

  const { name, display_name, description, github_info: gitHubInfo, category, archestra_config, tools } = server;

  // Safely extract OAuth and browser-based config with null checks
  const requiresOAuthSetup = !!server.oauth_config;
  const requiresBrowserBasedSetup = archestra_config?.browser_based?.required ?? false;
  const isRemoteMcp = server.server.type === 'remote';

  // Determine installation state
  const installedServer = installedMcpServers.find((s) => s.id === name);
  const isInstalled = installedServer && installedServer.status === 'installed';
  const isOAuthPending = installedServer && installedServer.status === 'oauth_pending';
  const isInstalling = installingMcpServerId === name;
  const isUninstalling = uninstallingMcpServerId === name;
  const installFailed = installedServer && installedServer.status === 'failed';

  const getCategoryIcon = (category?: string | null) => {
    if (!category) return <Package className="h-4 w-4" />;

    switch (category) {
      case 'Development':
      case 'CLI Tools':
      case 'Developer Tools':
        return <Code className="h-4 w-4" />;
      case 'Data':
      case 'Data Science':
      case 'Database':
        return <Database className="h-4 w-4" />;
      case 'File Management':
      case 'Knowledge':
        return <FileText className="h-4 w-4" />;
      case 'Browser Automation':
      case 'Web':
        return <Globe className="h-4 w-4" />;
      case 'Search':
        return <Search className="h-4 w-4" />;
      case 'Communication':
      case 'Social Media':
        return <MessageSquare className="h-4 w-4" />;
      default:
        return <Package className="h-4 w-4" />;
    }
  };

  const getQualityBadge = (score?: number | null) => {
    if (!score) return null;

    if (score >= 80) {
      return <Badge className="bg-green-500/10 text-green-600 border-green-500/20">Excellent</Badge>;
    } else if (score >= 60) {
      return <Badge className="bg-yellow-500/10 text-yellow-600 border-yellow-500/20">Good</Badge>;
    } else {
      return <Badge className="bg-orange-500/10 text-orange-600 border-orange-500/20">Fair</Badge>;
    }
  };

  const displayName = display_name || name;

  return (
    <>
      <Card
        className={`transition-all duration-200 hover:shadow-md overflow-hidden ${isInstalled ? 'ring-1 ring-green-500/30' : ''}`}
      >
        <CardHeader className="p-3 pb-2">
          <div className="space-y-1">
            <div className="grid grid-cols-[auto_1fr_auto] items-center gap-1 max-w-full">
              {getCategoryIcon(category)}
              <h3 className="font-medium text-sm truncate" title={displayName}>
                {displayName}
              </h3>
              <div className="flex items-center gap-0.5">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => window.electronAPI.openExternal(`https://www.archestra.ai/mcp-catalog/${name}`)}
                  className="h-5 w-5 p-0 cursor-pointer"
                  title="View in MCP Catalog"
                >
                  <Info className="h-3 w-3" />
                </Button>
                <ReportIssueWithCatalogEntry catalogId={name} />
                {isInstalled && <CheckCircle className="h-3.5 w-3.5 text-green-500" />}
              </div>
            </div>
            <p className="text-xs text-muted-foreground line-clamp-2 break-words">{description}</p>
          </div>
        </CardHeader>

        <CardContent className="p-3 pt-0 space-y-2 overflow-hidden">
          {/* Enhanced Metadata */}
          <div className="flex flex-wrap gap-2 text-xs">
            {gitHubInfo && gitHubInfo.stars > 0 && (
              <div className="flex items-center gap-0.5 text-muted-foreground">
                <Star className="h-3 w-3" />
                <span>{gitHubInfo.stars.toLocaleString()}</span>
              </div>
            )}
            {gitHubInfo && gitHubInfo.contributors > 0 && (
              <div className="flex items-center gap-0.5 text-muted-foreground">
                <Users className="h-3 w-3" />
                <span>{gitHubInfo.contributors}</span>
              </div>
            )}
            {tools && tools.length > 0 && (
              <div className="flex items-center gap-0.5 text-muted-foreground">
                <Settings className="h-3 w-3" />
                <span>{tools.length}</span>
              </div>
            )}
          </div>

          {/* Tags */}
          <div className="flex flex-wrap gap-1">
            {category && (
              <Badge variant="secondary" className="text-xs py-0 px-1.5">
                {category}
              </Badge>
            )}
            {requiresOAuthSetup && (
              <Badge variant="outline" className="text-xs py-0 px-1.5">
                OAuth
              </Badge>
            )}
          </div>

          {/* Actions */}
          <div className="pt-2">
            {!sandboxIsRunning ? (
              <Button size="sm" variant="outline" disabled className="w-full h-7 text-xs">
                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                Initializing...
              </Button>
            ) : isInstalled || installFailed ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onUninstallClick(name)}
                disabled={isUninstalling}
                className="w-full h-7 text-xs text-destructive hover:text-destructive cursor-pointer"
              >
                {isUninstalling ? (
                  <>
                    <div className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent mr-1" />
                    Uninstalling...
                  </>
                ) : (
                  'Uninstall'
                )}
              </Button>
            ) : isOAuthPending ? (
              <div className="flex flex-col gap-1">
                <div className="flex items-center justify-center text-xs text-muted-foreground mb-1">
                  <Clock className="h-3 w-3 mr-1" />
                  Waiting for OAuth...
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onCancelInstallClick?.(installedServer?.id || name)}
                  className="w-full h-7 text-xs text-destructive hover:text-destructive cursor-pointer"
                >
                  Cancel installation
                </Button>
              </div>
            ) : isInstalling ? (
              <>
                <Button size="sm" variant="outline" disabled className="w-full h-7 text-xs">
                  <div className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent mr-1" />
                  Installing...
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onCancelInstallClick?.(installedServer?.id || name)}
                  className="w-full h-7 mt-2 text-xs text-destructive hover:text-destructive cursor-pointer"
                >
                  Cancel
                </Button>
              </>
            ) : (
              <div className="flex flex-col gap-1">
                {/* For Remote MCP, only show Install (OAuth) button */}
                {isRemoteMcp ? (
                  <Button
                    size="sm"
                    variant="default"
                    onClick={() => onOAuthInstallClick?.(server)}
                    disabled={isInstalling}
                    className="w-full h-7 text-xs cursor-pointer"
                  >
                    Install
                  </Button>
                ) : (
                  <>
                    {!requiresOAuthSetup && !requiresBrowserBasedSetup && (
                      <Button
                        size="sm"
                        variant="default"
                        onClick={() => onInstallClick(server)}
                        disabled={isInstalling}
                        className="w-full h-7 text-xs cursor-pointer"
                      >
                        {server.user_config && Object.keys(server.user_config).length > 0
                          ? 'Install (config)'
                          : 'Install'}
                      </Button>
                    )}
                    {requiresOAuthSetup && (
                      <Button
                        size="sm"
                        variant="default"
                        onClick={() => onOAuthInstallClick?.(server)}
                        disabled={isInstalling}
                        className="w-full h-7 text-xs cursor-pointer"
                      >
                        Install (OAuth)
                      </Button>
                    )}
                    {requiresBrowserBasedSetup && (
                      <Button
                        size="sm"
                        variant="default"
                        onClick={() => {
                          if (onBrowserInstallClick) {
                            onBrowserInstallClick(server);
                          } else {
                            onInstallClick(server);
                          }
                        }}
                        disabled={isInstalling}
                        className="w-full h-7 text-xs cursor-pointer"
                      >
                        Install (Browser)
                      </Button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </>
  );
}
