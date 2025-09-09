import { Server } from 'lucide-react';

import { Badge } from '@ui/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@ui/components/ui/card';
import { Input } from '@ui/components/ui/input';
import { Label } from '@ui/components/ui/label';
import config from '@ui/config';
import { ConnectedMcpServer } from '@ui/types';

interface ArchestraMcpServerProps {
  archestraMcpServer: ConnectedMcpServer;
}

export default function ArchestraMcpServer({ archestraMcpServer: _archestraMcpServer }: ArchestraMcpServerProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="h-5 w-5" />
          Archestra MCP Server
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          The Archestra MCP server runs by default when you launch Archestra. It allows you to perform Archestra actions
          via interactions with your LLMs. Additionally, using the URL below, you can connect the Archestra MCP server
          to any MCP client.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <Label htmlFor="server-status">Server Status</Label>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                Running
              </Badge>
            </div>
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="server-url">Server URL</Label>
          <div className="flex items-center gap-2">
            <Input id="server-url" value={config.archestra.mcpUrl} readOnly className="font-mono text-sm" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
