"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type {
  ColumnDef,
  OnChangeFn,
  RowSelectionState,
} from "@tanstack/react-table";
import { AppWindow, Loader2 } from "lucide-react";
import { AgentNameCell } from "@/components/agent-name-cell";
import { RowPinButton } from "@/components/row-pin-button";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { DataTable } from "@/components/ui/data-table";
import { type PinAppTarget, usePinApp } from "@/lib/app.query";
import {
  appActionDisabledReason,
  computeAppAccess,
  useAppAccessContext,
} from "@/lib/apps/use-app-access";
import type { BulkRangeSelectionController } from "@/lib/bulk-range-selection";
import { AppTypeIcon } from "./app-type-icon";
import { useAppRowActions } from "./use-app-row-actions";
import { getAppRowKey, useOpenApp } from "./use-open-app";

type AppListItem = archestraApiTypes.GetAppsResponses["200"]["data"][number];

// The apps table under the pinned tiles. Its parent owns selection and bulk
// actions. Clicking a row opens the app in a new chat.
export function AppsTable({
  apps,
  onOpenSettings,
  rowSelection,
  setRowSelection,
  onPageRowIdsChange,
  rangeSelection,
}: {
  apps: AppListItem[];
  onOpenSettings: (app: { id: string }) => void;
  rowSelection: RowSelectionState;
  setRowSelection: OnChangeFn<RowSelectionState>;
  onPageRowIdsChange: (ids: string[]) => void;
  rangeSelection: BulkRangeSelectionController;
}) {
  const { open, openingKey } = useOpenApp();
  const pinApp = usePinApp();
  const accessContext = useAppAccessContext();
  const { actionsFor, dialogs } = useAppRowActions({ onOpenSettings });

  const togglePin = (app: AppListItem) =>
    pinApp.mutate({ pinned: !app.pinnedAt, target: pinTarget(app) });

  const columns: ColumnDef<AppListItem>[] = [
    createSelectColumn<AppListItem>({
      rowLabel: (app) => `Select ${app.name}`,
      allLabel: "Select all apps on this page",
      canSelect: (app) =>
        app.source === "owned" && computeAppAccess(app, accessContext).canEdit,
      disabledReason: (app) =>
        app.source === "owned"
          ? (appActionDisabledReason({
              app,
              access: computeAppAccess(app, accessContext),
              action: "update",
            }) ?? "You do not have permission to modify this app")
          : "Installed apps are managed through their MCP server",
    }),
    {
      id: "name",
      accessorKey: "name",
      header: "App",
      size: 280,
      cell: ({ row }) => {
        const app = row.original;
        return (
          <AgentNameCell
            name={app.name}
            icon={
              <AppTypeIcon owned={app.source === "owned"} icon={app.icon} />
            }
            labels={app.labels}
            description={app.description}
            extraBadges={
              <AppStatusBadges
                app={app}
                isOpening={openingKey === getAppRowKey(app)}
              />
            }
          />
        );
      },
    },
    {
      id: "kind",
      size: 130,
      header: "Kind",
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.original.source === "owned" ? "App" : "MCP server app"}
        </span>
      ),
    },
    {
      id: "actions",
      size: 190,
      header: () => <div className="text-right">Actions</div>,
      cell: ({ row }) => {
        const app = row.original;
        const actions = actionsFor(app);
        const isPrimaryAction = (action: TableRowAction) =>
          action.label === "Settings" || action.label === "Open in new tab";
        return (
          <div className="flex items-center justify-end gap-1.5">
            <RowPinButton
              name={app.name}
              pinned={Boolean(app.pinnedAt)}
              onToggle={() => togglePin(app)}
            />
            <TableRowActions
              permissionScope={app.source === "owned" ? app.id : undefined}
              actions={actions.filter(isPrimaryAction)}
              dropdownActions={actions.filter(
                (action) => !isPrimaryAction(action),
              )}
              itemName={app.name}
            />
          </div>
        );
      },
    },
  ];

  return (
    <>
      <DataTable
        columns={columns}
        data={apps}
        getRowId={getAppRowKey}
        rowSelection={rowSelection}
        onRowSelectionChange={setRowSelection}
        onPageRowIdsChange={onPageRowIdsChange}
        rangeSelection={rangeSelection}
        hideSelectedCount
        onRowClick={(app) => void open(app)}
        emptyIcon={AppWindow}
        emptyMessage="No apps here yet"
        hidePaginationWhenSinglePage
        tableClassName="table-fixed"
        fixedWidthColumnIds={["kind", "actions"]}
        flexibleColumnIds={["name"]}
      />

      {dialogs}
    </>
  );
}

// === shared helpers ===

export function pinTarget(app: AppListItem): PinAppTarget {
  return app.source === "owned"
    ? { source: "owned", appId: app.id }
    : {
        source: "external",
        mcpServerId: app.mcpServerId,
        resourceUri: app.resourceUri,
        toolName: app.toolName,
      };
}

function AppStatusBadges({
  app,
  isOpening,
}: {
  app: AppListItem;
  isOpening: boolean;
}) {
  // Someone else's personal app, reached only through app:admin oversight.
  const isForeignPersonalApp =
    app.source === "owned" &&
    app.scope === "personal" &&
    app.viewerRole === "admin";
  return (
    <>
      {app.source === "owned" && !app.enabled ? (
        <Badge variant="outline" className="shrink-0">
          Disabled
        </Badge>
      ) : null}
      {app.source === "owned" && app.locked ? (
        <Badge variant="outline" className="shrink-0">
          Locked
        </Badge>
      ) : null}
      {isForeignPersonalApp ? (
        <Badge variant="secondary" className="shrink-0">
          {app.authorName ? `Owned by ${app.authorName}` : "Other user"}
        </Badge>
      ) : null}
      {isOpening ? (
        <Loader2
          aria-label="Opening"
          className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
        />
      ) : null}
    </>
  );
}
