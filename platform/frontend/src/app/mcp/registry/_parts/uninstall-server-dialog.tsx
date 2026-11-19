"use client";

import { Loader2 } from "lucide-react";
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
import {
  useDeleteMcpServer,
  useMcpServersAssignedAgents,
} from "@/lib/mcp/mcp-server.query";
import { desktopRemoveCopy } from "./desktop-mcp-install";
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
    /** A desktop MCP server is removed from its user's computer. */
    serverType?: string | null;
    /**
     * Whether the install is the viewer's own; a desktop MCP server of
     * another user is removed from their computer. Unset reads as own.
     */
    ownedByViewer?: boolean;
  };
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
  // Server lists leave out each install's agents, so the confirmation reads
  // them for just the installs it removes. Confirm waits for them: the user
  // should see which agents lose access before removing a connection. Once
  // the uninstall runs they are settled, and rereading an install it just
  // removed would only answer "not found".
  const agentUsage = useMcpServersAssignedAgents({
    serverIds: servers.map(({ id }) => id),
    enabled: open && !isCancelingInstallation && !uninstallMutation.isPending,
  });
  const isLoadingAgents = !isCancelingInstallation && agentUsage.isPending;
  // Only the agents that route through the installs being removed: nobody
  // but its owner resolves to a personal connection, so the catalog's other
  // agents keep resolving to their own connections.
  const assignedAgents = Array.from(
    new Map(
      installs
        .flatMap((install) =>
          agentsLosingAccessOnUninstall({
            server: install.server,
            assignedAgents: agentUsage.agentsByServerId.get(install.server.id),
          }),
        )
        .map((agent) => [agent.id, agent]),
    ).values(),
  );
  const isBulk = installs.length > 1;
  // Removing one desktop MCP server stops it on its user's computer: no team
  // or organization connection is involved, and no installation in progress
  // is canceled.
  const computer = !isBulk && server ? desktopComputerOf(server) : undefined;
  const desktopCopy =
    server && computer
      ? desktopRemoveCopy({ name: server.name, mine: computer === "mine" })
      : null;
  const isDesktop = desktopCopy !== null;

  const handleConfirm = async () => {
    if (!server || isLoadingAgents) return;

    if (isCancelingInstallation && !isDesktop && onCancelInstallation) {
      onCancelInstallation(server.id);
    }

    for (const install of installs) {
      await uninstallMutation.mutateAsync({
        id: install.server.id,
        name: install.server.name,
        desktop: desktopComputerOf(install.server),
      });
    }
    onUninstalled?.(servers.map(({ id }) => id));
    onClose();
  };

  const title =
    desktopCopy?.title ??
    (isCancelingInstallation
      ? "Cancel Installation"
      : isBulk
        ? "Uninstall MCP Servers"
        : "Uninstall MCP Server");
  const description =
    desktopCopy?.description ??
    (isCancelingInstallation
      ? `Are you sure you want to cancel the installation of "${server?.name || ""}"?`
      : isBulk
        ? `Are you sure you want to uninstall ${installs.length} selected MCP server connections?`
        : [
            `Are you sure you want to uninstall "${server?.name || ""}"?`,
            server ? uninstallConsequence(server, !!seesSharedInstalls) : null,
          ]
            .filter(Boolean)
            .join(" "));
  const confirmButtonText =
    desktopCopy?.confirm ??
    (isCancelingInstallation
      ? "Cancel Installation"
      : isBulk
        ? "Uninstall selected"
        : "Uninstall");
  const confirmingButtonText =
    desktopCopy?.confirming ??
    (isCancelingInstallation
      ? "Canceling..."
      : isBulk
        ? "Uninstalling selected..."
        : "Uninstalling...");

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader className="border-b-0">
          {/* The desktop title is a full question: on a phone it stays left
              and clear of the close button. */}
          <DialogTitle
            className={isDesktop ? "pr-6 text-left leading-snug" : undefined}
          >
            {title}
          </DialogTitle>
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
            {isLoadingAgents && (
              <InlineNotice variant="neutral">
                <Loader2 className="animate-spin" />
                <span>
                  {isDesktop
                    ? "Searching agents that use it..."
                    : "Searching agents using this connection..."}
                </span>
              </InlineNotice>
            )}
            {!isCancelingInstallation && agentUsage.isError && (
              <InlineNotice variant="error">
                <span className="font-medium">Agents could not be loaded</span>
                <InlineNoticeText>
                  {isDesktop
                    ? "Agents with its tools may lose access to them."
                    : "Agents with tools assigned from this connection may lose access to them."}
                </InlineNoticeText>
              </InlineNotice>
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
                  {isDesktop
                    ? assignedAgents.length === 1
                      ? "uses its tools and loses them."
                      : "use its tools and lose them."
                    : `${assignedAgents.length === 1 ? "has" : "have"} tools assigned from this connection and may lose access to them.`}
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
              disabled={uninstallMutation.isPending || isLoadingAgents}
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

/**
 * Whose computer a desktop MCP server is removed from; undefined for a server
 * of another type.
 */
function desktopComputerOf(
  server: UninstallServerInstall["server"],
): "mine" | "theirs" | undefined {
  if (server.serverType !== "desktop_mcp") return undefined;
  return server.ownedByViewer === false ? "theirs" : "mine";
}
