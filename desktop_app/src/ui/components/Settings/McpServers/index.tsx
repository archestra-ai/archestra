import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  HelpCircle,
  Loader2,
  Plus,
  Server,
  Settings,
  XCircle,
} from 'lucide-react';
import { memo, useState } from 'react';

import DetailedProgressBar from '@ui/components/DetailedProgressBar';
import { Button } from '@ui/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@ui/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@ui/components/ui/tooltip';
import { useMcpServersStore, useSandboxStore, useToolsStore } from '@ui/stores';

import AddCustomServerDialog from './AddCustomServerDialog';
import McpServer from './McpServer';
import SandboxManagementDialog from './SandboxManagementDialog';

// Memoized tooltip component to prevent re-renders
const HelpTooltip = memo(() => (
  <Tooltip delayDuration={0}>
    <TooltipTrigger asChild>
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground hover:text-foreground transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
        }}
      >
        <HelpCircle className="h-3 w-3" />
        <span>Why it's important?</span>
      </button>
    </TooltipTrigger>
    <TooltipContent className="max-w-sm" sideOffset={5}>
      <p className="text-sm">
        MCP servers are programs that connect AI to data. Like any software, they pose risks to your host machine.
        Archestra runs MCP servers in isolated sandboxes, preventing them from accessing data they shouldn't have access
        to. This is an important and necessary security measure.
      </p>
    </TooltipContent>
  </Tooltip>
));
HelpTooltip.displayName = 'HelpTooltip';

interface McpServersProps {}

export default function McpServers(_props: McpServersProps) {
  const [sandboxManagementDialogOpen, setSandboxManagementDialogOpen] = useState(false);
  const [addServerDialogOpen, setAddServerDialogOpen] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  const {
    isRunning: sandboxIsRunning,
    statusSummary: {
      runtime: { startupPercentage, startupMessage, startupError },
    },
  } = useSandboxStore();
  const { installedMcpServers, loadingInstalledMcpServers, errorLoadingInstalledMcpServers } = useMcpServersStore();
  const { availableTools } = useToolsStore();

  const totalNumberOfMcpTools = availableTools.length;
  const hasErrorLoadingInstalledMcpServers = errorLoadingInstalledMcpServers !== null;

  const getOverallSandboxStatus = () => {
    if (startupError) {
      return {
        icon: <XCircle className="h-5 w-5 text-destructive" />,
        title: 'Sandbox Initialization Failed',
        description: startupError,
      };
    }

    if (startupPercentage > 0 && startupPercentage < 100) {
      return {
        icon: <Loader2 className="h-5 w-5 animate-spin" />,
        title: 'Initializing Container Runtime',
        description: startupMessage,
      };
    }

    /**
     * Only show "Sandbox Ready" if we've actually completed initialization (100%)
     * When startupPercentage is 0, it means initialization hasn't started yet
     */
    if (startupPercentage === 100) {
      return {
        icon: <CheckCircle className="h-5 w-5 text-green-500" />,
        title: 'Sandbox Ready',
        description: 'Container environment is up and running',
      };
    }

    // Default state when not yet initialized (startupPercentage === 0)
    return {
      icon: <Loader2 className="h-5 w-5 animate-spin" />,
      title: 'Initializing Sandbox',
      description: 'Starting container environment...',
    };
  };

  const overallSandboxStatus = getOverallSandboxStatus();

  if (!sandboxIsRunning) {
    return (
      <TooltipProvider>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <Server className="h-5 w-5" />
                Isolated MCP Runtime
                <HelpTooltip />
              </CardTitle>
              <Button
                variant="ghost"
                size="sm"
                className="cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  setSandboxManagementDialogOpen(true);
                }}
                title="Sandbox Management"
              >
                <Settings className="h-4 w-4 mr-1" />
                <span>Fix Issues</span>
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <DetailedProgressBar
              icon={overallSandboxStatus.icon}
              title={overallSandboxStatus.title}
              description={overallSandboxStatus.description}
              percentage={startupPercentage}
              error={startupError}
            />
          </CardContent>
        </Card>
        <SandboxManagementDialog open={sandboxManagementDialogOpen} onOpenChange={setSandboxManagementDialogOpen} />
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider>
      <Card>
        <Collapsible open={isOpen} onOpenChange={setIsOpen}>
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <Server className="h-5 w-5" />
                  Isolated MCP Runtime
                  <HelpTooltip />
                  {sandboxIsRunning && loadingInstalledMcpServers && <Loader2 className="h-4 w-4 animate-spin" />}
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSandboxManagementDialogOpen(true);
                    }}
                    title="Sandbox Management"
                  >
                    <Settings className="h-4 w-4 mr-1" />
                    <span>Fix Issues</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      setAddServerDialogOpen(true);
                    }}
                    title="Add Custom MCP Server"
                  >
                    <Plus className="h-4 w-4 mr-1" />
                    <span>Run Custom Server</span>
                  </Button>
                  {isOpen ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
                </div>
              </div>
              {/* Compact view when folded */}
              {!isOpen && installedMcpServers.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {installedMcpServers.map((server) => {
                    const isRunning = server.state === 'running';
                    const isConnecting = server.state === 'initializing';
                    const hasError = server.state === 'error';

                    return (
                      <div
                        key={server.id}
                        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
                          isRunning
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : isConnecting
                              ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                              : hasError
                                ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                        }`}
                        title={`${server.name}: ${server.state}`}
                      >
                        <div
                          className={`h-1.5 w-1.5 rounded-full ${
                            isRunning
                              ? 'bg-green-500 animate-pulse'
                              : isConnecting
                                ? 'bg-yellow-500 animate-pulse'
                                : hasError
                                  ? 'bg-red-500'
                                  : 'bg-gray-400'
                          }`}
                        />
                        <span className="truncate max-w-[120px]">{server.name}</span>
                      </div>
                    );
                  })}
                  {installedMcpServers.length > 0 && (
                    <div className="inline-flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground">
                      <span>
                        {installedMcpServers.filter((s) => s.state === 'running').length}/{installedMcpServers.length}{' '}
                        connected
                      </span>
                      <span className="text-muted-foreground/60">•</span>
                      <span>{totalNumberOfMcpTools} tools</span>
                    </div>
                  )}
                </div>
              )}
            </CardHeader>
          </CollapsibleTrigger>

          <CollapsibleContent>
            <CardContent className="space-y-4">
              {hasErrorLoadingInstalledMcpServers && (
                <div className="text-center py-4 text-muted-foreground">
                  <AlertCircle className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>Error loading MCP servers: {errorLoadingInstalledMcpServers}</p>
                </div>
              )}
              {loadingInstalledMcpServers && (
                <div className="text-center py-4 text-muted-foreground">
                  <Loader2 className="h-8 w-8 mx-auto mb-2 animate-spin" />
                  <p>Loading MCP servers...</p>
                </div>
              )}
              {installedMcpServers.length === 0 &&
              !loadingInstalledMcpServers &&
              !hasErrorLoadingInstalledMcpServers ? (
                <div className="text-center py-4 text-muted-foreground">
                  <Server className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No MCP servers configured</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {installedMcpServers.map((server) => (
                    <McpServer key={server.id} mcpServer={server} />
                  ))}
                </div>
              )}

              {installedMcpServers.length > 0 && (
                <div className="border-t pt-3 mt-4">
                  <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>
                      Total: {installedMcpServers.length} server
                      {installedMcpServers.length !== 1 ? 's' : ''}, {totalNumberOfMcpTools} tool
                      {totalNumberOfMcpTools !== 1 ? 's' : ''}
                    </span>
                    <span>{installedMcpServers.filter((s) => s.state === 'running').length} connected</span>
                  </div>
                </div>
              )}
            </CardContent>
          </CollapsibleContent>
        </Collapsible>

        <SandboxManagementDialog open={sandboxManagementDialogOpen} onOpenChange={setSandboxManagementDialogOpen} />
        <AddCustomServerDialog open={addServerDialogOpen} onOpenChange={setAddServerDialogOpen} />
      </Card>
    </TooltipProvider>
  );
}
