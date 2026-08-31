"use client";

import type { archestraApiTypes } from "@archestra/shared";
import {
  CONNECTOR_TYPE_LABELS,
  PERMISSION_SYNC_FOLLOW_DOCUMENTS_SCHEDULE,
} from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Database,
  Logs,
  MoreHorizontal,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Fragment, useCallback, useMemo, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { ConnectorDocumentOcrNotice } from "@/app/knowledge/connectors/_parts/connector-document-ocr-notice";
import { ConnectorDocumentsTable } from "@/app/knowledge/connectors/_parts/connector-documents-table";
import { ConnectorEmbeddingModelNotice } from "@/app/knowledge/connectors/_parts/connector-embedding-model-notice";
import { ConnectorMembersTable } from "@/app/knowledge/connectors/_parts/connector-members-table";
import { ConnectorRunDetailsDialog } from "@/app/knowledge/connectors/_parts/connector-run-details-dialog";
import { ConnectorUnassignedUsersAlert } from "@/app/knowledge/connectors/_parts/connector-unassigned-users-alert";
import { ConnectorUserGroupsTable } from "@/app/knowledge/connectors/_parts/connector-user-groups-table";
import { contentRunPhase } from "@/app/knowledge/connectors/_parts/content-run-phase";
import { GoogleDriveConnectionCard } from "@/app/knowledge/connectors/_parts/gdrive-connection-card";
import {
  capitalizeNoun,
  GROUP_ROSTER_NOUN,
  type RosterNoun,
  WORKSPACE_ROSTER_NOUN,
} from "@/app/knowledge/connectors/_parts/roster-noun";
import { formatRunDuration } from "@/app/knowledge/connectors/_parts/run-duration";
import { ConnectorStatusPill } from "@/app/knowledge/knowledge-bases/_parts/connector-enabled-dot";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { ConnectorStatusBadge } from "@/app/knowledge/knowledge-bases/_parts/connector-status-badge";
import { EditConnectorDialog } from "@/app/knowledge/knowledge-bases/_parts/edit-connector-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { type DetailFact, DetailFacts } from "@/components/detail-facts";
import {
  CollectionFilters,
  FilterBar,
  filterControlClass,
} from "@/components/filter-bar";
import { FormDialog } from "@/components/form-dialog";
import { LoadingState, LoadingWrapper } from "@/components/loading";
import { PageBackLink } from "@/components/page-back-link";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
import { RelativeTime } from "@/components/relative-time";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
  DialogHeader,
  DialogStickyFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useFeature } from "@/lib/config/config.query";
import { useAppName } from "@/lib/hooks/use-app-name";
import {
  useDialogFlagUrlParam,
  useDialogUrlParam,
} from "@/lib/hooks/use-dialog-url-param";
import {
  useAssignConnectorToKnowledgeBases,
  useCancelConnectorRun,
  useConnector,
  useConnectorKnowledgeBases,
  useConnectorPermissionCoverage,
  useConnectorRuns,
  useForceResyncConnector,
  useSyncConnector,
  useTestConnectorConnection,
  useTriggerPermissionSync,
  useUnassignConnectorFromKnowledgeBase,
} from "@/lib/knowledge/connector.query";
import { useKnowledgeBases } from "@/lib/knowledge/knowledge-base.query";
import { formatDate } from "@/lib/utils";
import { formatCronSchedule } from "@/lib/utils/format-cron";

type ConnectorRunItem =
  archestraApiTypes.GetConnectorRunsResponses["200"]["data"][number];

const QUEUED_ROW_ID_PREFIX = "queued-";

/**
 * Synthetic table row for a sync that is enqueued but not yet claimed by a
 * worker — there is no run row in the database to show yet. Lifecycle cells
 * (started/completed/result/logs) all guard on the "queued" status, so only
 * the fields they read are populated.
 */
function makeQueuedRow(runType: "content" | "permission"): ConnectorRunItem {
  return {
    id: `${QUEUED_ROW_ID_PREFIX}${runType}`,
    status: "queued",
    runType,
    startedAt: null,
    completedAt: null,
  } as unknown as ConnectorRunItem;
}

export default function ConnectorDetailPage({
  connectorId,
}: {
  connectorId: string;
}) {
  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <ConnectorDetail connectorId={connectorId} />
      </ErrorBoundary>
    </div>
  );
}

function ConnectorDetail({ connectorId }: { connectorId: string }) {
  const appName = useAppName();
  const searchParams = useSearchParams();
  const from = searchParams.get("from");
  const backHref =
    from === "knowledge-bases"
      ? "/knowledge/knowledge-bases"
      : "/knowledge/connectors";
  const backLabel =
    from === "knowledge-bases"
      ? "Back to Knowledge Bases"
      : "Back to Connectors";
  const tabParam = searchParams.get("tab");
  // "permission-runs" is a legacy deep link from when permission runs had
  // their own tab (lands on the merged Sync Runs tab pre-filtered);
  // "permissions" and "user-groups" are deep links from when Users and
  // Groups shared one Permissions tab (land on Users, where the fixes live).
  const currentTab =
    tabParam === "documents"
      ? "documents"
      : tabParam === "users" ||
          tabParam === "permissions" ||
          tabParam === "user-groups"
        ? "users"
        : tabParam === "groups"
          ? "groups"
          : "runs";

  const {
    data: connector,
    isPending,
    isLoadingError,
    refetch,
  } = useConnector(connectorId);

  // BETA: every permission-family surface on this page (Users/Groups tabs,
  // coverage, sync action, runs filter) keys off isAutoSync, so gating it on
  // the flag hides them all at once when the beta is off.
  const autoSyncBeta = useFeature("kbAutoSyncPermissionsEnabled") ?? false;
  // Content and permission runs share the one Sync Runs tab (a Type column
  // tells them apart, a filter narrows to one family); permission-only views
  // live behind the in-tab filter rather than a separate tab.
  const isAutoSync =
    connector?.visibility === "auto-sync-permissions" && autoSyncBeta;
  // Notion's one roster row per connector IS the workspace, so its page says
  // "Workspace(s)" wherever the group snapshot would say "Group(s)".
  const rosterNoun =
    connector?.connectorType === "notion" ? WORKSPACE_ROSTER_NOUN : undefined;
  const tabs = [
    { label: "Sync Runs", href: `/knowledge/connectors/${connectorId}` },
    {
      label: "Documents",
      href: `/knowledge/connectors/${connectorId}?tab=documents`,
    },
    ...(isAutoSync
      ? [
          {
            label: "Users",
            href: `/knowledge/connectors/${connectorId}?tab=users`,
          },
          {
            label: rosterNoun ? capitalizeNoun(rosterNoun.plural) : "Groups",
            href: `/knowledge/connectors/${connectorId}?tab=groups`,
          },
        ]
      : []),
  ];
  const syncConnector = useSyncConnector();
  const cancelRun = useCancelConnectorRun();
  const forceResync = useForceResyncConnector();
  const testConnection = useTestConnectorConnection();
  // Coverage feeds the Permissions metadata items and the Sync Permissions
  // menu item; the query polls while a pass runs so both stay live.
  const { data: coverage } = useConnectorPermissionCoverage({
    connectorId,
    enabled: isAutoSync,
  });
  const triggerPermissionSync = useTriggerPermissionSync();
  const permissionSyncRunning = coverage?.permissionSyncRunning ?? false;
  const { open: isEditOpen, setOpen: setIsEditOpen } =
    useDialogFlagUrlParam("edit");
  const [isForceResyncOpen, setIsForceResyncOpen] = useState(false);
  const [runToCancel, setRunToCancel] = useState<ConnectorRunItem | null>(null);

  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  // The run details dialog fetches the run itself from the id, so synthesize
  // the entity from the URL id instead of fetching it here.
  const runId = searchParams.get("run");
  const {
    entity: selectedRun,
    open: openRunDetails,
    close: closeRunDetails,
  } = useDialogUrlParam({
    paramName: "run",
    entityFromUrl: runId ? { id: runId } : null,
  });
  const [runTypeFilter, setRunTypeFilter] = useState<
    "all" | "content" | "permission"
  >(tabParam === "permission-runs" ? "permission" : "all");
  const [runStatusFilter, setRunStatusFilter] = useState<
    "all" | NonNullable<ConnectorRunItem["status"]>
  >("all");
  const [runResultFilter, setRunResultFilter] = useState<
    "all" | "changes" | "no-changes"
  >("all");

  const {
    data: runsData,
    isPending: isRunsPending,
    isFetching: isRunsFetching,
  } = useConnectorRuns({
    connectorId,
    limit: pageSize,
    offset: pageIndex * pageSize,
    // Non-auto-sync connectors only ever have content runs; auto-sync ones
    // default to the interleaved view and can narrow to one family.
    runType: !isAutoSync
      ? "content"
      : runTypeFilter === "all"
        ? undefined
        : runTypeFilter,
    status: runStatusFilter === "all" ? undefined : runStatusFilter,
    result: runResultFilter === "all" ? undefined : runResultFilter,
  });

  // Task-derived queued state (a sync is enqueued, no worker claimed it yet).
  // Rendered as synthetic pinned rows so a just-triggered sync is visible in
  // the table immediately — before any run row exists.
  const contentQueued = runsData?.queued?.content ?? false;
  const permissionQueued = runsData?.queued?.permission ?? false;
  const runRows = useMemo(() => {
    const runs = runsData?.data ?? [];
    // Queued rows only make sense on an unfiltered first page: they are not
    // real runs, so they must never satisfy a status/result filter or repeat
    // on later pages.
    if (
      pageIndex !== 0 ||
      runStatusFilter !== "all" ||
      runResultFilter !== "all"
    ) {
      return runs;
    }
    const synthetic: ConnectorRunItem[] = [];
    if (contentQueued && runTypeFilter !== "permission") {
      synthetic.push(makeQueuedRow("content"));
    }
    if (permissionQueued && isAutoSync && runTypeFilter !== "content") {
      synthetic.push(makeQueuedRow("permission"));
    }
    return [...synthetic, ...runs];
  }, [
    runsData,
    contentQueued,
    permissionQueued,
    pageIndex,
    runStatusFilter,
    runResultFilter,
    runTypeFilter,
    isAutoSync,
  ]);

  const handleSync = useCallback(async () => {
    await syncConnector.mutateAsync(connectorId);
  }, [syncConnector, connectorId]);

  const handleTestConnection = useCallback(async () => {
    await testConnection.mutateAsync(connectorId);
  }, [testConnection, connectorId]);

  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      setPageIndex(newPagination.pageIndex);
      setPageSize(newPagination.pageSize);
    },
    [],
  );

  // One table for both run families. Shared lifecycle columns (Status,
  // Started, Completed) line up across rows; the family-specific counters
  // collapse into a compact Results summary (the details dialog has the full
  // numbers), and a Type badge tells the families apart when interleaved.
  // The shared Table is `table-fixed`, so every column needs an explicit
  // size — otherwise all columns get equal widths and the long Results
  // summary renders under the Logs column.
  const columns: ColumnDef<ConnectorRunItem>[] = useMemo(
    () => [
      ...(isAutoSync
        ? [
            {
              id: "runType",
              header: "Type",
              size: 100,
              cell: ({ row }) => (
                <Badge variant="outline" className="text-xs font-normal">
                  {row.original.runType === "permission"
                    ? "Permissions"
                    : "Documents"}
                </Badge>
              ),
            } satisfies ColumnDef<ConnectorRunItem>,
          ]
        : []),
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        // Wide enough for the longest label ("Completed with errors"): the
        // shared Table does not clip overflow, so a badge wider than its
        // column paints over the next one instead of wrapping.
        size: 190,
        // Badge only — in-flight progress lives in the Result column, where
        // there is room for it.
        cell: ({ row }) => (
          <ConnectorStatusBadge status={row.original.status} />
        ),
      },
      {
        id: "startedAt",
        accessorKey: "startedAt",
        header: "Started",
        size: 150,
        // "8 minutes ago" rather than a second-precision stamp: at a glance
        // the question is how recent the run was, and the exact instant stays
        // one hover (and one dialog) away. The Duration column beside it
        // carries what the old Completed column was really used for.
        cell: ({ row }) => <RelativeTime date={row.original.startedAt} />,
      },
      {
        id: "duration",
        header: "Duration",
        size: 110,
        // A running row counts up: the runs query polls every 3s while any run
        // is in flight, so each poll re-renders this against the new now.
        cell: ({ row }) => {
          if (row.original.status === "queued") {
            return <span className="text-sm text-muted-foreground">-</span>;
          }
          const duration = formatRunDuration({
            startedAt: row.original.startedAt,
            completedAt: row.original.completedAt,
          });
          return (
            <span className="text-sm tabular-nums text-muted-foreground">
              {duration ?? "-"}
            </span>
          );
        },
      },
      {
        id: "results",
        header: "Result",
        // Deliberately the widest declared size: leftover table width lands
        // here (the one cell with real content) instead of stretching the
        // compact Status/Type columns.
        size: 460,
        minSize: 220,
        cell: ({ row }) => (
          <RunResultsSummary run={row.original} noun={rosterNoun} />
        ),
      },
      {
        // Named and rendered like every other table's Actions column rather
        // than a bare "Logs" header over a ghost icon.
        id: "actions",
        header: "Actions",
        size: 90,
        cell: ({ row }) => {
          // A queued row has no run (and no logs) behind it yet.
          if (row.original.status === "queued") return null;
          return (
            <TableRowActions
              // Every row's button would otherwise be an identical "View
              // logs" to a screen reader; the start time is what tells the
              // rows apart.
              itemName={
                row.original.startedAt
                  ? `for the run started ${formatDate({ date: row.original.startedAt })}`
                  : undefined
              }
              actions={[
                {
                  icon: <Logs className="h-4 w-4" />,
                  label: "View logs",
                  onClick: () => openRunDetails(row.original),
                },
                ...(row.original.status === "running" &&
                row.original.runType === "content"
                  ? [
                      {
                        icon: <Square className="h-4 w-4" />,
                        label: "Cancel sync",
                        tooltip: "Cancel this sync run",
                        variant: "destructive" as const,
                        onClick: () => setRunToCancel(row.original),
                      },
                    ]
                  : []),
              ]}
            />
          );
        },
      },
    ],
    [isAutoSync, openRunDetails, rosterNoun],
  );

  if (isPending) {
    return <LoadingState label="Loading connector…" variant="viewport" />;
  }

  if (isLoadingError) {
    return (
      <div className="p-6">
        <QueryLoadError
          title="Couldn't load this connector"
          onRetry={() => refetch()}
        />
      </div>
    );
  }

  // The uploads-backed connector is deliberately not part of the connectors
  // surface — it has no source to sync, no credentials and no schedule, and its
  // documents are managed on the knowledge-files page. It is excluded from the
  // list, so this page is only reachable by typing an id; same answer as an
  // unknown one rather than a detail page of empty panels.
  if (!connector || connector.connectorType === "file_upload") {
    return (
      <div className="p-6">
        <p className="text-muted-foreground">Connector not found.</p>
      </div>
    );
  }

  const facts: DetailFact[] = [
    {
      label: "Last documents sync",
      value: connector.lastSyncAt
        ? formatDate({ date: connector.lastSyncAt })
        : "Never",
    },
    {
      label: "Documents sync schedule",
      value: formatCronSchedule(connector.schedule),
    },
    {
      label: "Documents",
      value: (
        <span className="font-mono tabular-nums">
          {connector.totalDocsIngested.toLocaleString()}
        </span>
      ),
    },
    {
      label: "Knowledge bases",
      value: <KnowledgeBasesValue connectorId={connectorId} />,
    },
    ...(isAutoSync
      ? [
          {
            label: "Last permissions sync",
            value: permissionSyncRunning
              ? "Syncing now…"
              : connector.lastPermissionSyncAt
                ? formatDate({ date: connector.lastPermissionSyncAt })
                : "Never",
          },
          {
            label: "Permissions sync frequency",
            value: formatSyncFrequency(connector.permissionSyncIntervalSeconds),
          },
          // Exception-only: full coverage is the unremarkable steady state
          // (the system self-heals transient gaps), so the fact exists only
          // while documents are actually unreachable.
          ...(coverage && coverage.failClosedDocuments > 0
            ? [
                {
                  label: "Permissions coverage",
                  value: (
                    <span
                      className="text-amber-600"
                      title={`Their source permissions grant only accounts ${appName} hasn't matched to a user, so no one can read them yet. Map those accounts in the Users tab — they also resolve automatically once the source exposes their emails. Re-running a permission sync alone won't change this.`}
                    >
                      <span>
                        {coverage.failClosedDocuments.toLocaleString()} document
                      </span>
                      {coverage.failClosedDocuments === 1 ? null : (
                        <span>s</span>
                      )}
                      <span> with no resolvable readers</span>
                    </span>
                  ),
                },
              ]
            : []),
        ]
      : []),
  ];

  return (
    <PageLayout
      // The source's own mark, then the name. The status used to be a bare
      // coloured dot in this slot and the type a badge nested inside the <h1>
      // — which put a <p> inside a heading, folded the whole description into
      // the heading's accessible name, and hid the connector's type entirely
      // whenever it happened to have a description.
      title={
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-card">
            <ConnectorTypeIcon
              type={connector.connectorType}
              className="h-4 w-4"
            />
          </span>
          <span className="min-w-0 truncate">{connector.name}</span>
        </span>
      }
      documentTitle={connector.name}
      status={
        <ConnectorStatusPill
          enabled={connector.enabled}
          lastSyncStatus={connector.lastSyncStatus}
        />
      }
      backLink={<PageBackLink href={backHref}>{backLabel}</PageBackLink>}
      description={
        connector.description ? (
          <span className="line-clamp-2 max-w-2xl">
            {connector.description.length > 300
              ? `${connector.description.slice(0, 300)}…`
              : connector.description}
          </span>
        ) : (
          <span>
            {CONNECTOR_TYPE_LABELS[connector.connectorType] ??
              connector.connectorType}
          </span>
        )
      }
      tabs={tabs}
      actionButton={
        <div className="flex flex-wrap items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSync}
                  disabled={
                    syncConnector.isPending ||
                    contentQueued ||
                    connector.lastSyncStatus === "running"
                  }
                >
                  <Play className="h-4 w-4" />
                  {syncConnector.isPending
                    ? "Starting..."
                    : contentQueued
                      ? "Queued..."
                      : connector.lastSyncStatus === "running"
                        ? "Syncing..."
                        : "Sync Now"}
                </Button>
              </span>
            </TooltipTrigger>
            {contentQueued ? (
              <TooltipContent>
                Sync enqueued — waiting for a worker
              </TooltipContent>
            ) : connector.lastSyncStatus === "running" ? (
              <TooltipContent>Sync run in progress</TooltipContent>
            ) : null}
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                aria-label="Connector actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {isAutoSync && (
                <DropdownMenuItem
                  onClick={() => triggerPermissionSync.mutate(connectorId)}
                  disabled={
                    triggerPermissionSync.isPending || permissionSyncRunning
                  }
                >
                  <RefreshCw className="h-4 w-4" />
                  {permissionQueued
                    ? "Permissions sync queued…"
                    : permissionSyncRunning
                      ? "Permissions syncing…"
                      : triggerPermissionSync.isPending
                        ? "Starting..."
                        : "Sync Permissions Now"}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={handleTestConnection}
                disabled={testConnection.isPending}
              >
                <Plug className="h-4 w-4" />
                {testConnection.isPending ? "Testing..." : "Test Connection"}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setIsEditOpen(true)}>
                <Pencil className="h-4 w-4" />
                Edit
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={
                  forceResync.isPending ||
                  connector.lastSyncStatus === "running"
                }
                onClick={() => setIsForceResyncOpen(true)}
              >
                <RotateCcw className="h-4 w-4" />
                {forceResync.isPending ? "Starting..." : "Force Re-sync"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <FormDialog
            open={isForceResyncOpen}
            onOpenChange={setIsForceResyncOpen}
            title="Force Re-sync"
            description="This will delete all documents, chunks, and sync history for this connector, then start a fresh sync from scratch. This action cannot be undone."
            size="small"
          >
            <DialogStickyFooter className="mt-0">
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsForceResyncOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => {
                  forceResync.mutate(connectorId);
                  setIsForceResyncOpen(false);
                }}
              >
                Force Re-sync
              </Button>
            </DialogStickyFooter>
          </FormDialog>
        </div>
      }
    >
      <div className="space-y-6">
        <GoogleDriveConnectionCard connector={connector} />

        {/* The connector's own facts, reading as a continuation of the header
            band rather than as a bordered box of "metadata" below it. The
            documents family comes first, then its permissions counterpart. */}
        <DetailFacts facts={facts} className="border-b pb-6" />

        <ConnectorEmbeddingModelNotice
          connectorType={connector.connectorType}
        />
        <ConnectorDocumentOcrNotice connectorType={connector.connectorType} />

        {/* Visible on EVERY tab: an admin landing anywhere on the page
            learns about unassigned users without drilling into the Users
            table. Renders nothing while everyone resolves. */}
        {isAutoSync && (
          <ConnectorUnassignedUsersAlert
            connectorId={connectorId}
            connectorType={connector.connectorType}
          />
        )}

        {currentTab === "documents" ? (
          <ConnectorDocumentsTable
            connectorId={connectorId}
            showGroupFilter={isAutoSync}
            noun={rosterNoun}
          />
        ) : currentTab === "users" && isAutoSync ? (
          <ConnectorMembersTable connectorId={connectorId} noun={rosterNoun} />
        ) : currentTab === "groups" && isAutoSync ? (
          <ConnectorUserGroupsTable
            connectorId={connectorId}
            noun={rosterNoun}
          />
        ) : (
          <div>
            <CollectionFilters>
              <FilterBar>
                {isAutoSync && (
                  <Select
                    value={runTypeFilter}
                    onValueChange={(value) => {
                      setRunTypeFilter(value as typeof runTypeFilter);
                      setPageIndex(0);
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      className={filterControlClass({
                        active: runTypeFilter !== "all",
                      })}
                      aria-label="Filter runs"
                    >
                      <SelectValue placeholder="All runs" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All runs</SelectItem>
                      <SelectItem value="content">Documents</SelectItem>
                      <SelectItem value="permission">Permissions</SelectItem>
                    </SelectContent>
                  </Select>
                )}
                <Select
                  value={runStatusFilter}
                  onValueChange={(value) => {
                    setRunStatusFilter(value as typeof runStatusFilter);
                    setPageIndex(0);
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className={filterControlClass({
                      active: runStatusFilter !== "all",
                    })}
                    aria-label="Filter by status"
                  >
                    <SelectValue placeholder="All statuses" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="running">Running</SelectItem>
                    <SelectItem value="success">Success</SelectItem>
                    <SelectItem value="completed_with_errors">
                      Completed with errors
                    </SelectItem>
                    <SelectItem value="no_documents">No documents</SelectItem>
                    <SelectItem value="failed">Failed</SelectItem>
                    <SelectItem value="partial">Partial</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                    <SelectItem value="superseded">Superseded</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={runResultFilter}
                  onValueChange={(value) => {
                    setRunResultFilter(value as typeof runResultFilter);
                    setPageIndex(0);
                  }}
                >
                  <SelectTrigger
                    size="sm"
                    className={filterControlClass({
                      active: runResultFilter !== "all",
                    })}
                    aria-label="Filter by result"
                  >
                    <SelectValue placeholder="All results" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All results</SelectItem>
                    <SelectItem value="changes">With changes</SelectItem>
                    <SelectItem value="no-changes">No changes</SelectItem>
                  </SelectContent>
                </Select>
              </FilterBar>
            </CollectionFilters>
            <LoadingWrapper
              isPending={
                (isRunsPending || isRunsFetching) && runRows.length === 0
              }
              loadingFallback={<LoadingState />}
            >
              {runRows.length === 0 ? (
                <div className="text-muted-foreground">
                  {runStatusFilter !== "all" || runResultFilter !== "all"
                    ? "No runs match the selected filters."
                    : runTypeFilter === "permission"
                      ? "No permission sync runs yet. The first run tags this connector's documents with their upstream access."
                      : "No sync runs yet. Trigger a manual sync or wait for the scheduled sync."}
                </div>
              ) : (
                <DataTable
                  columns={columns}
                  data={runRows}
                  manualPagination={true}
                  pagination={{
                    pageIndex,
                    pageSize,
                    total: runsData?.pagination?.total ?? 0,
                  }}
                  onPaginationChange={handlePaginationChange}
                />
              )}
            </LoadingWrapper>
          </div>
        )}

        <ConnectorRunDetailsDialog
          connectorId={connectorId}
          runId={selectedRun?.id ?? null}
          onClose={closeRunDetails}
        />

        <DeleteConfirmDialog
          open={runToCancel !== null}
          onOpenChange={(open) => {
            if (!open) setRunToCancel(null);
          }}
          title="Cancel sync run"
          description="Stop fetching and processing new documents for this run? Documents already ingested remain available. The worker stops at the next source batch boundary."
          isPending={cancelRun.isPending}
          onConfirm={async () => {
            if (!runToCancel) return;
            const result = await cancelRun.mutateAsync({
              connectorId,
              runId: runToCancel.id,
            });
            if (result) setRunToCancel(null);
          }}
          confirmLabel="Cancel sync"
          pendingLabel="Cancelling..."
        />

        <EditConnectorDialog
          connector={connector}
          open={isEditOpen}
          onOpenChange={setIsEditOpen}
        />
      </div>
    </PageLayout>
  );
}

/**
 * Compact family-aware run outcome for the merged Sync Runs table. Completed
 * runs read as outcomes: only what changed, or "No changes". A RUNNING
 * content run reads as its current step — "Ingesting documents 14/23", then
 * "Embedding batch 80/459" — one step at a time; failed runs and in-flight
 * permission passes keep the counter set, counting up from zero, because a
 * live counter that has not moved yet still has to be visible. A settled full
 * permission reconcile is labelled as one and reports its scope plus whatever
 * moved. Full numbers live in the run details dialog.
 */
function RunResultsSummary({
  run,
  noun = GROUP_ROSTER_NOUN,
}: {
  run: ConnectorRunItem;
  noun?: RosterNoun;
}) {
  if (run.status === "queued") {
    return (
      <div className="text-sm text-muted-foreground">Waiting for a worker…</div>
    );
  }
  if (run.runType === "permission") {
    const stats = run.stats;
    if (!stats) return <div className="text-muted-foreground">-</div>;

    const accessListsUpdated = stats.containersChanged ?? 0;
    const membersRemoved = stats.membershipsRemoved ?? 0;
    const permissionsItem = countedItem(
      stats.aclsChanged,
      "permission updated",
      "permissions updated",
    );
    const accessListsItem = countedItem(
      accessListsUpdated,
      "access list updated",
      "access lists updated",
    );
    const memberItems: RunStatItem[] = [
      ...(stats.membershipsUpserted > 0
        ? [
            countedItem(
              stats.membershipsUpserted,
              `${noun.singular} member updated`,
              `${noun.singular} members updated`,
            ),
          ]
        : []),
      ...(membersRemoved > 0
        ? [
            countedItem(
              membersRemoved,
              `${noun.singular} member removed`,
              `${noun.singular} members removed`,
            ),
          ]
        : []),
    ];
    const lockedItem: RunStatItem = {
      ...countedItem(stats.failClosed, "doc locked", "docs locked"),
      warn: stats.failClosed > 0,
    };
    const groupsItem: RunStatItem = stats.groupSyncFailed
      ? { label: `${noun.singular} sync failed`, warn: true }
      : countedItem(
          stats.groupsSynced,
          `${noun.singular} checked`,
          `${noun.plural} checked`,
        );
    // A pass that could not READ a project's permissions hid everything in it.
    // It must never settle as "no changes" — from the outside that is
    // indistinguishable from a pass that found nothing to do.
    const unreadable = stats.containerAudienceFailures ?? 0;
    const unreadableItem: RunStatItem = {
      ...countedItem(
        unreadable,
        "access list unreadable",
        "access lists unreadable",
      ),
      warn: true,
    };

    // What this pass actually changed. Zero-valued counters are dropped: a
    // settled run is read for its outcome, and "0 permissions updated · 0
    // access lists updated · 0 docs locked" is three ways of saying nothing
    // happened — the noise that buried the one number that did move.
    const changes = [
      ...(stats.aclsChanged > 0 ? [permissionsItem] : []),
      ...(accessListsUpdated > 0 ? [accessListsItem] : []),
      ...memberItems,
      ...(stats.failClosed > 0 ? [lockedItem] : []),
      ...(unreadable > 0 ? [unreadableItem] : []),
      ...(stats.groupSyncFailed ? [groupsItem] : []),
    ];

    if (run.status === "success" && stats.mode === "delta") {
      if (changes.length === 0) {
        return noChangesVerdict;
      }
      return <RunStatLine items={changes} />;
    }

    // A settled FULL reconcile says so in words rather than by being the row
    // with the long listing. What it changed comes first — the scope counters
    // are the same every pass, so they are what should fall into the overflow
    // when the line runs out of room.
    if (run.status === "success") {
      return (
        <RunStatLine
          items={[
            { label: "Full reconcile" },
            ...changes,
            { value: stats.docsScanned, label: "docs checked" },
            ...(stats.groupSyncFailed ? [] : [groupsItem]),
          ]}
        />
      );
    }

    // Every settled success returned above, so this is a run still going or
    // one that ended badly: show progress against the total when there is one.
    const checked =
      stats.totalDocs > 0
        ? `${stats.docsScanned.toLocaleString()} / ${stats.totalDocs.toLocaleString()}`
        : stats.docsScanned;
    return (
      <RunStatLine
        items={[
          { value: checked, label: "docs checked" },
          permissionsItem,
          accessListsItem,
          ...(unreadable > 0 ? [unreadableItem] : []),
          lockedItem,
          groupsItem,
          ...memberItems,
        ]}
      />
    );
  }

  const phase = contentRunPhase(run);
  if (phase) {
    return (
      <div className="flex items-center gap-2">
        {phase.progress !== null && (
          <Progress value={phase.progress} className="h-1 w-16 shrink-0" />
        )}
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {phase.label}
        </span>
      </div>
    );
  }
  const ingested = run.documentsIngested ?? 0;
  if (run.status === "success") {
    if (ingested === 0) {
      return noChangesVerdict;
    }
    return <RunStatLine items={[{ value: ingested, label: "ingested" }]} />;
  }
  const processed = run.documentsProcessed ?? 0;
  const total = run.totalItems;
  return (
    <RunStatLine
      items={[
        {
          value:
            total != null && total > 0
              ? `${processed.toLocaleString()} / ${total.toLocaleString()}`
              : processed,
          label: "processed",
        },
        { value: ingested, label: "ingested" },
      ]}
    />
  );
}

/** The settled-run outcome shared by both run families. */
const noChangesVerdict = (
  <div className="text-sm text-muted-foreground">No changes</div>
);

type RunStatItem = { value?: number | string; label: string; warn?: boolean };

/** `1 access list updated` / `3 access lists updated`. */
function countedItem(
  value: number,
  singularLabel: string,
  pluralLabel: string,
): RunStatItem {
  return { value, label: value === 1 ? singularLabel : pluralLabel };
}

/** One results line: `<value> <muted label>` items joined by muted dots. */
function RunStatLine({ items }: { items: RunStatItem[] }) {
  const { visible, overflow } = splitRunStatItems(items);

  return (
    <div className="text-sm">
      {visible.map((item, index) => {
        const value = formatRunStatValue(item.value);
        return (
          <Fragment key={item.label}>
            {index > 0 && <span className="text-muted-foreground"> · </span>}
            {item.warn ? (
              <span className="text-amber-600">
                {value != null ? `${value} ` : ""}
                {item.label}
              </span>
            ) : (
              <>
                {value != null && `${value} `}
                <span className="text-muted-foreground">{item.label}</span>
              </>
            )}
          </Fragment>
        );
      })}
      {overflow.length > 0 && (
        <>
          <span className="text-muted-foreground"> · </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-default text-muted-foreground underline decoration-dotted underline-offset-2">
                +{overflow.length} more
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              <div className="space-y-0.5">
                {overflow.map((item) => (
                  <div key={item.label}>
                    {formatRunStatValue(item.value)} {item.label}
                  </div>
                ))}
              </div>
            </TooltipContent>
          </Tooltip>
        </>
      )}
    </div>
  );
}

/** Longest one-line result before the tail collapses behind "+N more". */
const MAX_VISIBLE_RUN_STATS = 3;

/**
 * Keeps a result line to one row. Anything a run flagged (locked documents,
 * an unreadable access list, a failed group refresh) stays on screen however
 * long the line gets — those are the reason to look at the row at all; the
 * unremarkable counters past the cap collapse into the overflow tooltip.
 */
function splitRunStatItems(items: RunStatItem[]): {
  visible: RunStatItem[];
  overflow: RunStatItem[];
} {
  const visible: RunStatItem[] = [];
  const overflow: RunStatItem[] = [];
  for (const item of items) {
    if (item.warn || visible.length < MAX_VISIBLE_RUN_STATS) {
      visible.push(item);
    } else {
      overflow.push(item);
    }
  }
  return { visible, overflow };
}

function formatRunStatValue(value: RunStatItem["value"]) {
  return typeof value === "number" ? value.toLocaleString() : value;
}

/** "Every 30 minutes" / "Every 6 hours" from an interval in seconds. */
function formatSyncFrequency(intervalSeconds: number): string {
  if (intervalSeconds === PERMISSION_SYNC_FOLLOW_DOCUMENTS_SCHEDULE) {
    return "Follows the documents sync schedule";
  }
  const minutes = Math.round(intervalSeconds / 60);
  if (minutes < 60 || minutes % 60 !== 0) {
    return `Every ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const hours = minutes / 60;
  return `Every ${hours} hour${hours === 1 ? "" : "s"}`;
}

function KnowledgeBasesValue({ connectorId }: { connectorId: string }) {
  const { data: assignedKbs, isPending } =
    useConnectorKnowledgeBases(connectorId);
  const { data: allKbs } = useKnowledgeBases();
  const assignMutation = useAssignConnectorToKnowledgeBases();
  const unassignMutation = useUnassignConnectorFromKnowledgeBase();
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [selectedKbId, setSelectedKbId] = useState<string>("");

  const assignedIds = new Set((assignedKbs?.data ?? []).map((kb) => kb.id));
  const availableKbs = (allKbs ?? []).filter((kb) => !assignedIds.has(kb.id));

  const handleAssign = useCallback(async () => {
    if (!selectedKbId) return;
    const result = await assignMutation.mutateAsync({
      connectorId,
      knowledgeBaseIds: [selectedKbId],
    });
    if (result) {
      setSelectedKbId("");
      setIsAddDialogOpen(false);
    }
  }, [selectedKbId, connectorId, assignMutation]);

  const handleUnassign = useCallback(
    async (knowledgeBaseId: string) => {
      await unassignMutation.mutateAsync({ connectorId, knowledgeBaseId });
    },
    [connectorId, unassignMutation],
  );

  const kbItems = assignedKbs?.data ?? [];

  return (
    <>
      {isPending ? (
        <LoadingState label="Loading knowledge bases…" variant="inline" />
      ) : kbItems.length === 0 ? (
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">None</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={() => setIsAddDialogOpen(true)}
            aria-label="Add knowledge base"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {kbItems.map((kb) => (
            <Badge key={kb.id} variant="secondary" className="gap-1 pr-1">
              <Database className="h-3 w-3" />
              {kb.name}
              <Button
                variant="ghost"
                size="icon"
                className="h-4 w-4 ml-0.5 hover:bg-destructive/20"
                onClick={() => handleUnassign(kb.id)}
                disabled={unassignMutation.isPending}
                aria-label="Remove knowledge base"
              >
                <X className="h-3 w-3" />
              </Button>
            </Badge>
          ))}
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            onClick={() => setIsAddDialogOpen(true)}
            disabled={availableKbs.length === 0}
            aria-label="Add knowledge base"
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Assign to Knowledge Base</DialogTitle>
            <DialogDescription>
              Select a knowledge base to assign this connector to.
            </DialogDescription>
          </DialogHeader>
          <DialogForm onSubmit={handleAssign}>
            <div className="py-2">
              <Select value={selectedKbId} onValueChange={setSelectedKbId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a knowledge base" />
                </SelectTrigger>
                <SelectContent>
                  {availableKbs.map((kb) => (
                    <SelectItem key={kb.id} value={kb.id}>
                      {kb.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsAddDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!selectedKbId || assignMutation.isPending}
              >
                {assignMutation.isPending ? "Assigning..." : "Assign"}
              </Button>
            </DialogFooter>
          </DialogForm>
        </DialogContent>
      </Dialog>
    </>
  );
}
