/**
 * MCP server setup wizard.
 * Currently there is only one setup provider: WhatsApp.
 */
import React from 'react';

import { type MCPSetup } from '@backend/websocket';
import WhatsAppSetup from '@ui/components/ConnectorCatalog/McpServerSetup/WhatsAppSetup';
import { Dialog, DialogContent } from '@ui/components/ui/dialog';

export default function McpServerSetup({
  open,
  onOpenChange,
  provider,
  status,
  content,
  serverId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: MCPSetup['provider'];
  status: MCPSetup['status'];
  content: string;
  serverId: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
        {(() => {
          switch (provider) {
            case 'whatsapp':
              return (
                <WhatsAppSetup
                  content={content}
                  status={status}
                  serverId={serverId}
                  closeDialog={() => onOpenChange(false)}
                />
              );
            default:
              return null;
          }
        })()}
      </DialogContent>
    </Dialog>
  );
}
