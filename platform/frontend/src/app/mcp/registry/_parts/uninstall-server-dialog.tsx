"use client";

import { useState } from "react";
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
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useDeleteMcpServer } from "@/lib/mcp/mcp-server.query";
import { agentOwnerLabel } from "./mcp-server-agent-usage";
import {
  agentsLosingAccessOnUninstall,
  uninstallConsequence,
} from "./uninstall-scope";
import { useSeesAllAgents } from "./use-sees-all-agents";

export interface UninstallServerInstall {
  server: {
    id: string;
    name: string;
    scope?: "personal" | "team" | "org";
    teamId?: string | null;
  };
  /** Agents with tools explicitly assigned from this install. */
  assignedAgents?: Array<{
    id: string;
    name: string;
    scope: string;
    ownerEmail: string | null;
    /** Bound to this install rather than resolved to one at call time. */
    pinned: boolean;
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
  installs: liveInstalls,
  isCancelingInstallation = false,
  onCancelInstallation,
  onUninstalled,
}: UninstallServerDialogProps) {
  const uninstallMutation = useDeleteMcpServer();
  // Someone who sees only their own installations and agents needs neither
  // the reassurance about shared connections nor an owner on each agent.
  const { data: seesSharedInstalls } = useHasPermissions({
    mcpServerInstallation: ["update"],
  });
  const seesAllAgents = useSeesAllAgents();

  // Callers derive installs from the server list, which drops a server as
  // soon as its uninstall lands. Hold what the user confirmed so the dialog
  // doesn't go blank while it finishes and closes.
  const [installs, setInstalls] = useState(liveInstalls);
  if (
    liveInstalls !== installs &&
    liveInstalls.length > 0 &&
    !uninstallMutation.isPending
  ) {
    setInstalls(liveInstalls);
  }

  const server = installs[0]?.server ?? null;
  const servers = installs.map((install) => install.server);
  // Only the agents that route through the installs being removed: nobody
  // but its owner resolves to a personal connection, so the catalog's other
  // agents keep resolving to their own connections.
  const assignedAgents = Array.from(
    new Map(
      installs
        .flatMap((install) => agentsLosingAccessOnUninstall(install))
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
      : [
          `Are you sure you want to uninstall "${server?.name || ""}"?`,
          server
            ? uninstallConsequence(server, {
                seesSharedInstalls: !!seesSharedInstalls,
              })
            : null,
        ]
          .filter(Boolean)
          .join(" ");
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
              <InlineNotice>
                <span className="font-medium">
                  Used by {assignedAgents.length}{" "}
                  {assignedAgents.length === 1 ? "agent" : "agents"}
                </span>
                <InlineNoticeText>
                  {/*
                    Personal agents share a name across members, so for someone
                    who sees everyone's an unqualified list reads as a repeated
                    "My Assistant" — name the owner to make each one
                    identifiable. Anyone else sees only agents they can open.
                  */}
                  {assignedAgents
                    .map((agent) => {
                      const owner = seesAllAgents
                        ? agentOwnerLabel(agent)
                        : null;
                      return owner ? `${agent.name} (${owner})` : agent.name;
                    })
                    .join(", ")}{" "}
                  {assignedAgents.length === 1 ? "has" : "have"} tools assigned
                  from this connection and may lose access to them.
                </InlineNoticeText>
              </InlineNotice>
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
