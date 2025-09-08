import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Loader2,
  Plus,
  Server,
  Settings,
  XCircle,
} from 'lucide-react';
import React, { useState } from 'react';

import DetailedProgressBar from '@ui/components/DetailedProgressBar';
import { Button } from '@ui/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@ui/components/ui/collapsible';
import { useMcpServersStore, useSandboxStore, useToolsStore } from '@ui/stores';

import AddCustomServerDialog from './AddCustomServerDialog';
import McpServer from './McpServer';
import SandboxManagementDialog from './SandboxManagementDialog';

interface McpServersProps {}

export default function McpServers(_props: McpServersProps) {
  const [sandboxManagementDialogOpen, setSandboxManagementDialogOpen] = useState(false);
  const [addServerDialogOpen, setAddServerDialogOpen] = useState(false);
  const [isOpen, setIsOpen] = useState(true);

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

  const HeaderTitle = ({ children }: React.PropsWithChildren) => {
    return (
      <CardTitle className="flex items-center gap-2">
        <Server className="h-5 w-5" />
        MCP Server Sandbox
        {children}
      </CardTitle>
    );
  };

  if (!sandboxIsRunning) {
    return (
      <Card>
        <CardHeader>
          <HeaderTitle />
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
    );
  }

  return (
    <Card>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            <div className="flex items-center justify-between">
              <HeaderTitle>
                {sandboxIsRunning && loadingInstalledMcpServers && <Loader2 className="h-4 w-4 animate-spin" />}
              </HeaderTitle>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSandboxManagementDialogOpen(true);
                  }}
                  title="Sandbox Management"
                >
                  <Settings className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 cursor-pointer"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAddServerDialogOpen(true);
                  }}
                  title="Add Custom MCP Server"
                >
                  <Plus className="h-4 w-4" />
                </Button>
                {isOpen ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
              </div>
            </div>
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
            {installedMcpServers.length === 0 && !loadingInstalledMcpServers && !hasErrorLoadingInstalledMcpServers ? (
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
  );
}
