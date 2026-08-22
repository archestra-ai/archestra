"use client";

import type { RowSelectionState } from "@tanstack/react-table";
import { Bell, BellOff, Loader2, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useRestoreMcpServerAlerts } from "@/lib/mcp/mcp-server.query";
import type {
  McpServerAttentionFacet,
  McpServerIssue,
} from "@/lib/mcp/mcp-server-issues";
import { canFixInstall, facetIssues } from "@/lib/mcp/mcp-server-issues";
import {
  DismissAlertDialog,
  type DismissAlertTarget,
} from "./dismiss-alert-dialog";
import {
  mcpServerAlertTarget,
  mcpServerAlertTargetKey,
} from "./mcp-server-alert-target";
import type { CatalogItem, InstalledServer } from "./mcp-server-card";
import { McpServerTable } from "./mcp-server-table";
import {
  UninstallServerDialog,
  type UninstallServerInstall,
} from "./uninstall-server-dialog";

export function McpServerAttentionList({
  items,
  issuesByCatalog,
  servers,
  facet,
  tableContext,
  onReinstall,
}: {
  items: CatalogItem[];
  issuesByCatalog: Map<string, McpServerIssue[]>;
  servers: InstalledServer[];
  facet: McpServerAttentionFacet;
  tableContext?: Pick<
    React.ComponentProps<typeof McpServerTable>,
    | "getServerInfo"
    | "envLabelByCatalog"
    | "deploymentFeedState"
    | "deploymentStatuses"
    | "installingItemId"
    | "onInstall"
    | "onCancelInstallation"
  >;
  onReinstall: React.ComponentProps<typeof McpServerTable>["onReinstall"];
}) {
  const [selectedTargetKeys, setSelectedTargetKeys] = useState<
    ReadonlySet<string>
  >(new Set());
  const [dismissOpen, setDismissOpen] = useState(false);
  const [uninstallOpen, setUninstallOpen] = useState(false);
  const { data: session } = useSession();
  const { data: canManageInstalls } = useHasPermissions({
    mcpServerInstallation: ["admin"],
  });
  const { data: canDeleteInstalls } = useHasPermissions({
    mcpServerInstallation: ["delete"],
  });
  const restoreMutation = useRestoreMcpServerAlerts();
  const restoring = restoreMutation.isPending;
  const restoringDismissed = facet === "muted";
  const effectiveTableContext = tableContext ?? {
    getServerInfo: (item: CatalogItem) => ({
      installedServer: servers.find((server) => server.catalogId === item.id),
    }),
    envLabelByCatalog: new Map<string, string | null>(),
    deploymentFeedState: "disabled" as const,
    deploymentStatuses: {},
    installingItemId: null,
    onInstall: () => {},
    onCancelInstallation: undefined,
  };

  const selectableIssuesByItem = useMemo(() => {
    const map = new Map<string, SelectableAlertIssue[]>();
    for (const item of items) {
      map.set(
        item.id,
        facetIssues(issuesByCatalog.get(item.id) ?? [], facet).map((issue) => ({
          issue,
          // The failure timestamp keeps a later episode on the same resource
          // from inheriting an old selection.
          selectionKey: `${item.id}:${issue.kind}:${issue.serverId ?? "catalog"}:${issue.since ?? issue.detail ?? "current"}:${issue.muted}`,
        })),
      );
    }
    return map;
  }, [items, issuesByCatalog, facet]);

  const selectableItemIds = items
    .filter((item) => (selectableIssuesByItem.get(item.id)?.length ?? 0) > 0)
    .map((item) => item.id);
  const selectableIssues = items.flatMap(
    (item) => selectableIssuesByItem.get(item.id) ?? [],
  );
  const selectedIssues = selectableIssues.filter((entry) =>
    selectedTargetKeys.has(entry.selectionKey),
  );
  const selectedItems = items.filter((item) =>
    (selectableIssuesByItem.get(item.id) ?? []).some((entry) =>
      selectedTargetKeys.has(entry.selectionKey),
    ),
  );
  const viewer = {
    userId: session?.user?.id ?? null,
    canManageInstalls: !!canManageInstalls,
  };
  const selectedConnectionsByItem = selectedItems.map((item) => {
    const explicitIds = new Set(
      selectedIssues
        .filter(({ issue }) => issue.catalogId === item.id)
        .flatMap(({ issue }) => (issue.serverId ? [issue.serverId] : [])),
    );
    const catalogServers = servers.filter(
      (server) => server.catalogId === item.id,
    );
    if (explicitIds.size > 0) {
      const explicitServers = catalogServers.filter((server) =>
        explicitIds.has(server.id),
      );
      return explicitServers.length === explicitIds.size ? explicitServers : [];
    }
    return catalogServers.length === 1 ? catalogServers : [];
  });
  const everySelectedItemIsRemovable =
    selectedItems.length > 0 &&
    selectedConnectionsByItem.every(
      (connections) =>
        connections.length > 0 &&
        connections.every((server) => canFixInstall({ server, viewer })),
    );
  const selectedConnections = everySelectedItemIsRemovable
    ? Array.from(
        new Map(
          selectedConnectionsByItem.flat().map((server) => [server.id, server]),
        ).values(),
      )
    : [];
  const selectedUninstallInstalls: UninstallServerInstall[] =
    selectedConnections.map((server) => ({
      server: { id: server.id, name: server.name },
      assignedAgents: server.assignedAgents ?? [],
    }));
  const canRemoveSelected =
    !!canDeleteInstalls &&
    everySelectedItemIsRemovable &&
    selectedUninstallInstalls.length > 0;
  const selectedDismissTargets = selectedIssues.map((entry) =>
    mcpServerAlertTarget({
      issue: entry.issue,
      item: items.find((item) => item.id === entry.issue.catalogId),
      servers,
    }),
  );
  const rowSelection: RowSelectionState = Object.fromEntries(
    selectedItems.map((item) => [item.id, true]),
  );

  const updateSelection = (
    update: (current: ReadonlySet<string>) => ReadonlySet<string>,
  ) => {
    setSelectedTargetKeys(update);
  };
  const setRowSelection = (next: RowSelectionState) => {
    const selectedIds = new Set(
      Object.entries(next)
        .filter(([, selected]) => selected)
        .map(([itemId]) => itemId),
    );
    setSelectedTargetKeys(
      new Set(
        items
          .filter((item) => selectedIds.has(item.id))
          .flatMap((item) =>
            (selectableIssuesByItem.get(item.id) ?? []).map(
              (entry) => entry.selectionKey,
            ),
          ),
      ),
    );
  };
  const clearSelection = () => updateSelection(() => new Set());
  const removeCompletedSelections = (
    succeededTargets: readonly DismissAlertTarget[],
  ) => {
    const succeededKeys = new Set(
      succeededTargets.map(mcpServerAlertTargetKey),
    );
    updateSelection((previous) => {
      const next = new Set(previous);
      for (const entry of selectableIssues) {
        const target = mcpServerAlertTarget({
          issue: entry.issue,
          item: items.find((item) => item.id === entry.issue.catalogId),
          servers,
        });
        if (succeededKeys.has(mcpServerAlertTargetKey(target))) {
          next.delete(entry.selectionKey);
        }
      }
      return next;
    });
  };

  const restoreSelected = async () => {
    const result = await restoreMutation.mutateAsync({
      alerts: selectedDismissTargets,
    });
    removeCompletedSelections(result.succeeded);
  };

  return (
    <div className="space-y-3" data-testid="mcp-registry-attention-list">
      <div className="flex flex-col gap-3 rounded-lg border bg-muted/50 p-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          {selectedItems.length > 0 ? (
            <>
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                {selectedItems.length}
              </span>
              <span className="text-sm font-medium">
                {selectedItems.length === 1
                  ? "MCP server selected"
                  : "MCP servers selected"}
              </span>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">
              {selectableItemIds.length > 0
                ? "Select MCP servers to apply bulk actions"
                : restoringDismissed
                  ? "No restorable alerts in this view"
                  : "No actionable alerts in this view"}
            </span>
          )}
          {restoring && (
            <Loader2
              aria-label="Restoring selected alerts"
              className="h-4 w-4 animate-spin text-muted-foreground"
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          {restoringDismissed ? (
            <Button
              variant="outline"
              size="sm"
              disabled={selectedDismissTargets.length === 0 || restoring}
              onClick={() => void restoreSelected()}
            >
              <Bell className="h-4 w-4" />
              Restore selected
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={selectedDismissTargets.length === 0}
                onClick={() => setDismissOpen(true)}
              >
                <BellOff className="h-4 w-4" />
                Dismiss selected
              </Button>
              {facet === "you" && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!canRemoveSelected}
                  title={
                    !canDeleteInstalls
                      ? "You do not have permission to remove MCP connections"
                      : selectedItems.length === 0
                        ? "Select MCP servers to remove their connections"
                        : !everySelectedItemIsRemovable
                          ? "Every selected row must identify connections you can remove"
                          : undefined
                  }
                  onClick={() => setUninstallOpen(true)}
                >
                  <Trash2 className="h-4 w-4 text-destructive" />
                  Remove connections
                </Button>
              )}
            </>
          )}
          {selectedItems.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clearSelection}>
              Clear selection
            </Button>
          )}
        </div>
      </div>

      <McpServerTable
        items={items}
        issuesByCatalog={issuesByCatalog}
        onReinstall={onReinstall}
        {...effectiveTableContext}
        attention={{
          facet,
          servers,
          rowSelection,
          onRowSelectionChange: setRowSelection,
          onTargetsCompleted: removeCompletedSelections,
        }}
      />

      <DismissAlertDialog
        open={dismissOpen}
        onClose={() => setDismissOpen(false)}
        targets={selectedDismissTargets}
        onDismissed={removeCompletedSelections}
      />
      <UninstallServerDialog
        open={uninstallOpen}
        onClose={() => setUninstallOpen(false)}
        installs={selectedUninstallInstalls}
        onUninstalled={clearSelection}
      />
    </div>
  );
}

type SelectableAlertIssue = {
  issue: McpServerIssue;
  selectionKey: string;
};
