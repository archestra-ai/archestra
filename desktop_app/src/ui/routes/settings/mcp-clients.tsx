import { createFileRoute } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';

import ArchestraMcpServer from '@ui/components/Settings/ArchestraMcpServer';
import { Badge } from '@ui/components/ui/badge';
import { Button } from '@ui/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ui/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@ui/components/ui/tooltip';
import { useExternalMcpClientsStore, useMcpServersStore } from '@ui/stores';

export const Route = createFileRoute('/settings/mcp-clients')({
  component: ExternalClients,
});

function ExternalClients() {
  const {
    supportedExternalMcpClientNames,
    connectedExternalMcpClients,
    isDisconnectingExternalMcpClient,
    disconnectExternalMcpClient,
  } = useExternalMcpClientsStore();

  const { archestraMcpServer } = useMcpServersStore();
  const archestraMcpServerIsLoading = archestraMcpServer === null;

  return (
    <div className="space-y-3">
      <div className="mb-4">
        <h1 className="text-2xl font-bold">Use as MCP Proxy</h1>
        <p className="text-muted-foreground">Connect external MCP clients to Archestra's MCP server</p>
      </div>

      {archestraMcpServerIsLoading ? (
        <div>Loading Archestra MCP server...</div>
      ) : (
        <ArchestraMcpServer archestraMcpServer={archestraMcpServer} />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {supportedExternalMcpClientNames.map((clientName) => {
          const connectedExternalMcpClient = connectedExternalMcpClients.find(
            (client) => client.clientName === clientName
          );
          const isConnected = connectedExternalMcpClient !== undefined;

          return (
            <Card key={clientName}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <div className="w-8 h-8 bg-gradient-to-br from-orange-400 to-orange-600 rounded-md flex items-center justify-center text-white font-bold text-sm">
                    {clientName.charAt(0).toUpperCase()}
                  </div>
                  <span className="text-lg font-medium">{clientName}</span>
                </CardTitle>
                <CardDescription>Connect {clientName} to your Archestra MCP server.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  {isConnected && (
                    <div className="space-y-1">
                      <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                        Connected
                      </Badge>
                    </div>
                  )}
                  {!isConnected ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>
                          <Button className="cursor-not-allowed opacity-50" variant="outline" size="sm" disabled>
                            Connect
                          </Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>This feature is not available yet</p>
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <Button
                      className="cursor-pointer"
                      variant="destructive"
                      size="sm"
                      onClick={() => disconnectExternalMcpClient(clientName)}
                      disabled={isDisconnectingExternalMcpClient}
                    >
                      {isDisconnectingExternalMcpClient ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Disconnecting...
                        </>
                      ) : (
                        'Disconnect'
                      )}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
