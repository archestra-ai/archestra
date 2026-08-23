"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogForm,
  DialogHeader,
  DialogStickyFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDeleteMcpServer } from "@/lib/mcp/mcp-server.query";
import { agentOwnerLabel } from "./mcp-server-agent-usage";

export interface UninstallServerInstall {
  server: { id: string; name: string };
  /** Agents with tools explicitly assigned from this install. */
  assignedAgents?: Array<{
    id: string;
    name: string;
    scope: string;
    ownerEmail: string | null;
  }>;
}

interface UninstallServerDialogProps {
  open: boolean;
  onClose: () => void;
  installs: UninstallServerInstall[];
  isCancelingInstallation?: boolean;
  onCancelInstallation?: (serverId: string) => void;
  onUninstalled?: (serverIds: string[]) => void;
}

export function UninstallServerDialog({
  open,
  onClose,
  installs,
  isCancelingInstallation = false,
  onCancelInstallation,
  onUninstalled,
}: UninstallServerDialogProps) {
  const uninstallMutation = useDeleteMcpServer();

  const server = installs[0]?.server ?? null;
  const servers = installs.map((install) => install.server);
  const assignedAgents = Array.from(
    new Map(
      installs
        .flatMap((install) => install.assignedAgents ?? [])
        .map((agent) => [agent.id, agent]),
    ).values(),
  );
  const isBulk = installs.length > 1;

  const handleConfirm = async () => {
    if (!server) return;

    if (isCancelingInstallation && onCancelInstallation) {
      onCancelInstallation(server.id);
    }

    for (const install of installs) {
      await uninstallMutation.mutateAsync({
        id: install.server.id,
        name: install.server.name,
      });
    }
    onUninstalled?.(servers.map(({ id }) => id));
    onClose();
  };

  const title = isCancelingInstallation
    ? "Cancel Installation"
    : isBulk
      ? "Uninstall MCP Servers"
      : "Uninstall MCP Server";
  const description = isCancelingInstallation
    ? `Are you sure you want to cancel the installation of "${server?.name || ""}"?`
    : isBulk
      ? `Are you sure you want to uninstall ${installs.length} selected MCP server connections?`
      : `Are you sure you want to uninstall "${server?.name || ""}"?`;
  const confirmButtonText = isCancelingInstallation
    ? "Cancel Installation"
    : isBulk
      ? "Uninstall selected"
      : "Uninstall";
  const confirmingButtonText = isCancelingInstallation
    ? "Canceling..."
    : isBulk
      ? "Uninstalling selected..."
      : "Uninstalling...";

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader className="border-b-0">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogForm
          className="flex min-h-0 flex-1 flex-col"
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) {
              return;
            }
            e.preventDefault();
            handleConfirm();
          }}
          onSubmit={(e) => {
            e.preventDefault();
            handleConfirm();
          }}
        >
          <div className="flex flex-col gap-3 px-4 pb-4">
            <DialogDescription>{description}</DialogDescription>
            {isBulk && (
              <ul className="max-h-32 space-y-1 overflow-y-auto rounded-md border bg-muted/30 px-3 py-2 text-sm">
                {servers.map((selectedServer) => (
                  <li key={selectedServer.id}>{selectedServer.name}</li>
                ))}
              </ul>
            )}
            {!isCancelingInstallation && assignedAgents.length > 0 && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
                <p className="font-medium text-amber-600 dark:text-amber-500">
                  Used by {assignedAgents.length}{" "}
                  {assignedAgents.length === 1 ? "agent" : "agents"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {/*
                    Personal agents share a name across members, so an
                    unqualified list reads as a repeated "My Assistant" — name
                    the owner to make each one identifiable.
                  */}
                  {assignedAgents
                    .map((agent) => {
                      const owner = agentOwnerLabel(agent);
                      return owner ? `${agent.name} (${owner})` : agent.name;
                    })
                    .join(", ")}{" "}
                  {assignedAgents.length === 1 ? "has" : "have"} tools assigned
                  from this server and may lose access to them.
                </p>
              </div>
            )}
          </div>
          <DialogStickyFooter className="mt-0 border-t-0 shadow-none">
            <Button type="button" variant="outline" onClick={() => onClose()}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={uninstallMutation.isPending}
            >
              {uninstallMutation.isPending
                ? confirmingButtonText
                : confirmButtonText}
            </Button>
          </DialogStickyFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
