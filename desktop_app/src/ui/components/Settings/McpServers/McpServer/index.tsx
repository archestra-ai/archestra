import { AlertCircle, CheckCircle, FileText, Loader2, Settings, Trash2, Wrench } from 'lucide-react';
import { useState } from 'react';

import McpServerSetup from '@ui/components/ConnectorCatalog/McpServerSetup';
import ReportIssueWithCatalogEntry from '@ui/components/ReportIssueWithCatalogEntry';
import { Badge } from '@ui/components/ui/badge';
import { Button } from '@ui/components/ui/button';
import { Card, CardContent } from '@ui/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@ui/components/ui/dialog';
import { Progress } from '@ui/components/ui/progress';
import config from '@ui/config';
import { useMcpServersStore, useToolsStore } from '@ui/stores';
import { ConnectedMcpServer } from '@ui/types';

import LogViewerDialog from './LogViewerDialog';

interface McpServerProps {
  mcpServer: ConnectedMcpServer;
}

export default function McpServer({
  mcpServer: { id, name, state, error, startupPercentage, message, remoteUrl },
}: McpServerProps) {
  const [showLogs, setShowLogs] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [showUninstallDialog, setShowUninstallDialog] = useState(false);
  const { uninstallMcpServer, uninstallingMcpServerId, mcpServerSetup } = useMcpServersStore();
  const { availableTools } = useToolsStore();

  const url = `${config.archestra.mcpProxyUrl}/${id}`;
  const isRunning = state === 'running';
  const isUninstalling = uninstallingMcpServerId === id;
  const tools = availableTools.filter((tool) => tool.mcpServerId === id);
  const hasFetchedTools = tools.length > 0;
  const isRemoteMcp = !!remoteUrl;
  const setup = mcpServerSetup[id];

  const getStateIcon = (state: ConnectedMcpServer['state']) => {
    switch (state) {
      case 'initializing':
        return <Loader2 className="h-4 w-4 animate-spin text-yellow-500" />;
      case 'running':
        return <CheckCircle className="h-4 w-4 text-green-500" />;
      case 'error':
        return <AlertCircle className="h-4 w-4 text-red-500" />;
    }
  };

  const getStateBadge = (state: ConnectedMcpServer['state']) => {
    switch (state) {
      case 'initializing':
        return (
          <Badge variant="outline" className="text-yellow-600 border-yellow-500">
            Connecting
          </Badge>
        );
      case 'running':
        return (
          <Badge variant="outline" className="text-green-600 border-green-500">
            Connected
          </Badge>
        );
      case 'error':
        return (
          <Badge variant="outline" className="text-red-600 border-red-500">
            Error
          </Badge>
        );
    }
  };

  const getSetupBadge = () => {
    if (!setup) return null;

    if (setup.status === 'pending') {
      return (
        <Badge
          variant="outline"
          className="text-orange-600 border-orange-500 cursor-pointer hover:bg-orange-50 hover:text-orange-700"
          onClick={() => setShowSetup(true)}
          title="Open MCP setup"
        >
          Setup Required
        </Badge>
      );
    }

    if (setup.status === 'error') {
      return (
        <Badge
          variant="outline"
          className="text-red-600 border-red-500 cursor-pointer hover:bg-red-50 hover:text-red-700"
          onClick={() => setShowSetup(true)}
          title="Setup failed - click to retry"
        >
          Setup Failed
        </Badge>
      );
    }

    return null;
  };

  const Tools = () => {
    if (!isRunning) {
      // MCP server is still starting up.. not possible to display tools related information just yet
      return null;
    } else if (!hasFetchedTools) {
      // MCP server is running, but tools have not yet been fetched
      return <div className="text-sm text-muted-foreground italic">Loading tools...</div>;
    } else if (tools.length === 0) {
      // MCP server is running, and tools have been fetched, but no tools are available
      return <div className="text-sm text-muted-foreground italic">No tools available from this server</div>;
    } else {
      // MCP server is running, and tools have been fetched, and tools are available
      return (
        <div className="space-y-2">
          <h5 className="text-sm font-medium flex items-center gap-1">
            <Wrench className="h-3 w-3" />
            Available Tools
          </h5>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {tools.map((tool) => (
              <div
                key={`${name}-${tool.name}`}
                className="p-2 border rounded-md bg-background/50 hover:bg-background transition-colors"
              >
                <div className="flex items-start justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-sm font-medium truncate">{tool.name}</div>
                    {tool.description && (
                      <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{tool.description}</div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    }
  };

  return (
    <>
      <Card className="border-l-4 border-l-blue-500/20">
        <CardContent className="pt-4">
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {getStateIcon(state)}
                <h4 className="font-medium">{name}</h4>
                {getStateBadge(state)}
                {getSetupBadge()}
              </div>
              <div className="flex items-center gap-2">
                <div className="text-xs text-muted-foreground">
                  {tools.length} tool
                  {tools.length !== 1 ? 's' : ''}
                </div>
                {state === 'running' && !isRemoteMcp && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 cursor-pointer"
                    onClick={() => setShowLogs(true)}
                    title="View container logs"
                  >
                    <FileText className="h-3 w-3" />
                  </Button>
                )}
                {setup && (
                  <div className="relative">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 cursor-pointer"
                      onClick={() => setShowSetup(true)}
                      title="Open MCP setup"
                    >
                      <Settings className="h-3 w-3" />
                    </Button>
                    {setup.status === 'pending' && (
                      <div className="absolute top-0 right-0 h-2 w-2 bg-orange-500 rounded-full"></div>
                    )}
                    {setup.status === 'error' && (
                      <div className="absolute top-0 right-0 h-2 w-2 bg-red-500 rounded-full"></div>
                    )}
                  </div>
                )}
                {(state === 'running' || isRemoteMcp) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 cursor-pointer"
                    onClick={() => setShowUninstallDialog(true)}
                    title="Uninstall MCP server"
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                )}
                <ReportIssueWithCatalogEntry catalogId={id} />
              </div>
            </div>

            <div className="text-xs text-muted-foreground font-mono bg-muted/50 px-2 py-1 rounded">{url}</div>

            {/* Show container status message when initializing */}
            {state === 'initializing' && message && (
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground">{message}</div>
                {startupPercentage > 0 && startupPercentage < 100 && (
                  <Progress value={startupPercentage} className="h-1" />
                )}
              </div>
            )}

            {state === 'error' && error && (
              <div className="text-xs text-red-600 bg-red-50 dark:bg-red-950/30 px-2 py-1 rounded border border-red-200 dark:border-red-800">
                Error: {error}
              </div>
            )}

            <Tools />
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={showUninstallDialog}
        onOpenChange={(open) => {
          // Prevent closing dialog while uninstalling
          if (!isUninstalling) {
            setShowUninstallDialog(open);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Uninstall {name}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will remove the MCP server and all its tools. This action cannot be undone.
          </p>
          <div className="flex gap-2 justify-end mt-4">
            <Button
              variant="outline"
              onClick={() => setShowUninstallDialog(false)}
              disabled={isUninstalling}
              className="cursor-pointer"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                await uninstallMcpServer(id);
                setShowUninstallDialog(false);
              }}
              disabled={isUninstalling}
              className="cursor-pointer"
            >
              {isUninstalling ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Uninstalling...
                </>
              ) : (
                'Uninstall'
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <LogViewerDialog open={showLogs} onOpenChange={setShowLogs} mcpServerId={id} mcpServerName={name} />
      {setup && (
        <McpServerSetup
          open={setup && showSetup}
          onOpenChange={setShowSetup}
          provider={setup.provider}
          content={setup.content}
          status={setup.status}
          serverId={id}
        />
      )}
    </>
  );
}
