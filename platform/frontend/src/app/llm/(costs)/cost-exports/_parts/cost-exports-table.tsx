"use client";

import type { Permissions } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  CalendarClock,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  FileSpreadsheet,
  HardDrive,
  ListFilter,
  Loader2,
  type LucideIcon,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { AgentNameCell } from "@/components/agent-name-cell";
import {
  openRowOnPlainClick,
  RowClickShield,
} from "@/components/agent-pages/row-click-shield";
import {
  BlobProviderLogo,
  blobProviderLocation,
} from "@/components/blob-provider-logo";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { BulkActionsScope } from "@/components/ui/bulk-actions-context";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { DataTable } from "@/components/ui/data-table";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { PermissionButton } from "@/components/ui/permission-button";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import type { BlobProvider } from "@/lib/blob-provider.query";
import type { CostExport } from "@/lib/cost-export.query";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";

/**
 * Cost exports by run health: failing first, filterable by destination and
 * status, with bulk pause, resume and delete, and a way to fix or retry a
 * failing destination from its row.
 */
export function CostExportsTable(props: {
  exports: CostExport[];
  /** Every blob provider, for each export's destination type and URI. */
  providers: BlobProvider[];
  isLoading: boolean;
  onEdit: (costExport: CostExport) => void;
  onDelete: (costExport: CostExport) => void;
  onRun: (costExport: CostExport) => void;
  /** Export whose Run now request is in flight, if any. */
  runningId: string | null;
  /** Opens the add-blob-provider dialog on this page. */
  onAddProvider: () => void;
  /** Opens a destination's edit dialog on this page, to fix a failing one. */
  onEditProvider: (provider: BlobProvider) => void;
  /** Resolves once the batch is done; the selection clears on full success. */
  onBulkSetEnabled: (
    exports: readonly CostExport[],
    enabled: boolean,
  ) => Promise<{ failed: unknown[] }>;
  /** Resolves once the batch is done; the selection clears on full success. */
  onBulkDelete: (
    exports: readonly CostExport[],
  ) => Promise<{ failed: unknown[] }>;
}) {
  const {
    exports,
    providers,
    isLoading,
    onEdit,
    onDelete,
    onRun,
    runningId,
    onAddProvider,
    onEditProvider,
    onBulkSetEnabled,
    onBulkDelete,
  } = props;
  const now = useNow();
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const search = searchParams.get("search") || "";
  const statusFilter = (searchParams.get("status") || ALL) as Health | "all";
  const destinationFilter = searchParams.get("destination") || ALL;
  const hasActiveFilters =
    search.trim().length > 0 ||
    statusFilter !== ALL ||
    destinationFilter !== ALL;
  const clearFilters = () =>
    updateQueryParams({
      search: null,
      status: null,
      destination: null,
      page: "1",
    });
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const providerById = useMemo(
    () => new Map(providers.map((p) => [p.id, p])),
    [providers],
  );

  // Health is derived once per row; the table, the filter counts and the
  // default order (failing first, paused last) all read the same value.
  const rows = useMemo(
    () =>
      exports
        .map((costExport) => ({
          costExport,
          health: healthOf(costExport),
          provider: providerById.get(costExport.blobProviderId),
        }))
        .sort(
          (a, b) =>
            HEALTH_ORDER.indexOf(a.health) - HEALTH_ORDER.indexOf(b.health) ||
            a.costExport.name.localeCompare(b.costExport.name),
        ),
    [exports, providerById],
  );

  const counts = useMemo(() => {
    const result: Record<Health, number> = {
      failing: 0,
      waiting: 0,
      healthy: 0,
      paused: 0,
    };
    for (const row of rows) result[row.health]++;
    return result;
  }, [rows]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (statusFilter !== ALL && row.health !== statusFilter) return false;
      if (
        destinationFilter !== ALL &&
        row.costExport.blobProviderId !== destinationFilter
      ) {
        return false;
      }
      if (!query) return true;
      return [
        row.costExport.name,
        row.costExport.blobProviderName,
        row.costExport.pathPrefix,
        row.provider ? blobProviderLocation(row.provider).uri : "",
      ].some((field) => field.toLowerCase().includes(query));
    });
  }, [rows, search, statusFilter, destinationFilter]);

  const {
    rowSelection,
    setRowSelection,
    onPageRowIdsChange,
    clearSelection,
    selected: selectedRows,
    selectAllMatching,
  } = useBulkSelection({
    rows: filtered,
    getId: (row) => row.costExport.id,
    filterSignature: `${search}|${statusFilter}|${destinationFilter}`,
    matchDescription: hasActiveFilters ? "match these filters" : "exist",
  });
  const selected = selectedRows.map((row) => row.costExport);
  const runBulk = async (
    action: () => Promise<{ failed: unknown[] }>,
  ): Promise<void> => {
    setBulkBusy(true);
    try {
      const outcome = await action();
      if (outcome.failed.length === 0) clearSelection();
    } finally {
      setBulkBusy(false);
    }
  };
  // Destinations that exports write to, for the destination filter.
  const destinations = useMemo(() => {
    const ids = new Set(exports.map((e) => e.blobProviderId));
    return providers.filter((provider) => ids.has(provider.id));
  }, [exports, providers]);

  const columns: ColumnDef<Row>[] = useMemo(
    () => [
      createSelectColumn<Row>({
        rowLabel: (row) => `Select ${row.costExport.name}`,
        allLabel: "Select all cost exports on this page",
      }),
      {
        id: "name",
        header: "Name",
        size: 200,
        cell: ({ row }) => {
          const { costExport } = row.original;
          return (
            <AgentNameCell
              name={costExport.name}
              description={`${costExport.schedule === "hourly" ? "Hourly" : "Daily"} · FOCUS 1.2 CSV`}
              onClick={() => onEdit(costExport)}
            />
          );
        },
      },
      {
        id: "destination",
        header: "Destination",
        size: 220,
        cell: ({ row }) => <DestinationCell row={row.original} />,
      },
      {
        id: "status",
        header: "Status",
        size: 224,
        cell: ({ row }) => (
          <StatusCell
            row={row.original}
            onRetry={() => onRun(row.original.costExport)}
            onFixDestination={
              row.original.provider
                ? () => onEditProvider(row.original.provider as BlobProvider)
                : undefined
            }
            retryDisabled={isRunning(row.original.costExport, runningId)}
            running={isRunning(row.original.costExport, runningId)}
          />
        ),
      },
      {
        id: "writtenThrough",
        header: "Written through",
        size: 168,
        cell: ({ row }) => <WrittenThroughCell row={row.original} now={now} />,
      },
      {
        id: "nextFile",
        header: "Next file",
        size: 156,
        cell: ({ row }) => (
          <NextFileCell
            row={row.original}
            now={now}
            running={isRunning(row.original.costExport, runningId)}
          />
        ),
      },
      {
        id: "actions",
        header: "Actions",
        size: 120,
        cell: ({ row }) => {
          const { costExport } = row.original;
          const running = isRunning(costExport, runningId);
          const failing = row.original.health === "failing";
          return (
            <TableRowActions
              itemName={costExport.name}
              actions={[
                {
                  icon: running ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : failing ? (
                    <RotateCw className="h-4 w-4" />
                  ) : (
                    <Play className="h-4 w-4" />
                  ),
                  label: running ? "Running…" : failing ? "Retry" : "Run now",
                  tooltip: failing
                    ? "Retry the write from the last good period"
                    : "Write the latest completed period now, replacing its file",
                  permissions: EDIT,
                  disabled: running,
                  disabledTooltip: "Running…",
                  onClick: () => onRun(costExport),
                },
                {
                  icon: <Pencil className="h-4 w-4" />,
                  label: "Edit",
                  permissions: EDIT,
                  onClick: () => onEdit(costExport),
                },
                {
                  icon: <Trash2 className="h-4 w-4" />,
                  label: "Delete",
                  permissions: DELETE,
                  variant: "destructive",
                  onClick: () => onDelete(costExport),
                },
              ]}
            />
          );
        },
      },
    ],
    [now, runningId, onEdit, onDelete, onRun, onEditProvider],
  );

  const noProviders = !isLoading && providers.length === 0;
  const showFilters = exports.length > 0 || hasActiveFilters;

  return (
    <BulkActionsScope>
      {showFilters && (
        <CollectionFilters>
          <FilterBar
            onClearFilters={hasActiveFilters ? clearFilters : undefined}
            search={
              <SearchInput
                objectNamePlural="cost exports"
                searchFields={["name", "destination"]}
                className={filterSearchClass}
              />
            }
          >
            <FilterSelect
              value={destinationFilter}
              onValueChange={(value) =>
                updateQueryParams({
                  destination: value === ALL ? null : value,
                  page: "1",
                })
              }
              inactiveValue={ALL}
              placeholder="Filter by destination"
              showSearch={destinations.length > 6}
              items={[
                {
                  value: ALL,
                  label: "All destinations",
                  content: (
                    <FilterOption icon={<FilterIcon />}>
                      All destinations
                    </FilterOption>
                  ),
                },
                ...destinations.map((provider) => ({
                  value: provider.id,
                  label: provider.name,
                  content: (
                    <FilterOption
                      icon={<BlobProviderLogo type={provider.type} size={14} />}
                    >
                      {provider.name}
                    </FilterOption>
                  ),
                })),
              ]}
            />
            <FilterSelect
              value={statusFilter}
              onValueChange={(value) =>
                updateQueryParams({
                  status: value === ALL ? null : value,
                  page: "1",
                })
              }
              inactiveValue={ALL}
              placeholder="Filter by status"
              showSearch={false}
              items={[
                {
                  value: ALL,
                  label: "All statuses",
                  content: (
                    <FilterOption icon={<FilterIcon />} count={exports.length}>
                      All statuses
                    </FilterOption>
                  ),
                },
                ...HEALTH_ORDER.map((health) => {
                  const { label, icon: Icon, tone } = HEALTH[health];
                  return {
                    value: health,
                    label,
                    content: (
                      <FilterOption
                        icon={
                          <Icon
                            aria-hidden
                            className={cn("size-3.5", TONE_CLASSES[tone])}
                          />
                        }
                        count={counts[health]}
                      >
                        {label}
                      </FilterOption>
                    ),
                  };
                }),
              ]}
            />
          </FilterBar>
        </CollectionFilters>
      )}
      <BulkActions
        count={selected.length}
        noun="cost export"
        onClear={clearSelection}
        busy={bulkBusy}
        selectAllMatching={selectAllMatching}
      >
        <PermissionButton
          permissions={EDIT}
          variant="outline"
          size="sm"
          disabled={bulkBusy}
          onClick={() => void runBulk(() => onBulkSetEnabled(selected, false))}
        >
          <Pause className="h-4 w-4" />
          <span>Pause</span>
        </PermissionButton>
        <PermissionButton
          permissions={EDIT}
          variant="outline"
          size="sm"
          disabled={bulkBusy}
          onClick={() => void runBulk(() => onBulkSetEnabled(selected, true))}
        >
          <Play className="h-4 w-4" />
          <span>Resume</span>
        </PermissionButton>
        <PermissionButton
          permissions={DELETE}
          variant="destructive"
          size="sm"
          disabled={bulkBusy}
          onClick={() => setBulkDeleteOpen(true)}
        >
          <Trash2 className="h-4 w-4" />
          <span>Delete</span>
        </PermissionButton>
      </BulkActions>
      <DataTable
        columns={columns}
        data={filtered}
        isLoading={isLoading && exports.length === 0}
        getRowId={(row) => row.costExport.id}
        rowSelection={rowSelection}
        onRowSelectionChange={setRowSelection}
        onPageRowIdsChange={onPageRowIdsChange}
        hideSelectedCount
        onRowClick={(row, event) =>
          openRowOnPlainClick(event, () => onEdit(row.costExport))
        }
        {...(noProviders
          ? {
              emptyIcon: HardDrive,
              emptyMessage: "Add a destination first",
              emptyDescription:
                "A cost export needs a blob provider to write its FOCUS files to: an S3, GCS or Azure Blob bucket you own.",
              emptyAction: (
                <PermissionButton
                  permissions={{ organizationSettings: ["update"] }}
                  onClick={onAddProvider}
                >
                  <Plus className="h-4 w-4" />
                  Add blob provider
                </PermissionButton>
              ),
            }
          : {
              emptyIcon: FileSpreadsheet,
              emptyMessage: "No cost exports scheduled",
              emptyDescription:
                "Schedule one to send hourly or daily FOCUS cost files to your bucket.",
            })}
        hasActiveFilters={hasActiveFilters}
        filteredEmptyMessage="No cost exports match your filters"
        onClearFilters={clearFilters}
        hidePaginationWhenSinglePage
        fixedWidthColumnIds={[
          "status",
          "writtenThrough",
          "nextFile",
          "actions",
        ]}
        flexibleColumnIds={["name", "destination"]}
      />
      {bulkDeleteOpen && (
        <DeleteConfirmDialog
          open={bulkDeleteOpen}
          onOpenChange={setBulkDeleteOpen}
          title="Delete cost exports"
          description={`Stop ${selected.length} ${selected.length === 1 ? "cost export" : "cost exports"}? Files already written stay in the bucket.`}
          isPending={bulkBusy}
          confirmLabel="Delete cost exports"
          pendingLabel="Deleting..."
          onConfirm={async () => {
            await runBulk(() => onBulkDelete(selected));
            setBulkDeleteOpen(false);
          }}
        />
      )}
    </BulkActionsScope>
  );
}

// === internal ===

type Health = "failing" | "waiting" | "healthy" | "paused";
type Row = {
  costExport: CostExport;
  health: Health;
  provider: BlobProvider | undefined;
};

const ALL = "all";

/** A run is queued or in progress, or its Run now request is in flight. */
function isRunning(costExport: CostExport, runningId: string | null): boolean {
  return costExport.running || runningId === costExport.id;
}
const LINK =
  "whitespace-nowrap rounded-sm font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:text-muted-foreground disabled:no-underline";
const EDIT: Permissions = {
  costExport: ["update"],
  llmCost: ["read"],
};
const DELETE: Permissions = { costExport: ["delete"] };
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A period is written this long after it ends (mirrors the backend). */
const SETTLE_MS = 15 * 60 * 1000;

/** Default order: what needs attention first, deliberate pauses last. */
const HEALTH_ORDER: Health[] = ["failing", "waiting", "healthy", "paused"];

type Tone = "neutral" | "success" | "info" | "warning" | "danger";
const TONE_CLASSES: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  success: "text-green-600 dark:text-green-400",
  info: "text-blue-600 dark:text-blue-400",
  warning: "text-amber-700 dark:text-amber-400",
  danger: "text-red-700 dark:text-red-400",
};

const HEALTH: Record<Health, { label: string; icon: LucideIcon; tone: Tone }> =
  {
    failing: { label: "Failing", icon: TriangleAlert, tone: "danger" },
    waiting: {
      label: "Waiting for first file",
      icon: CircleDashed,
      tone: "info",
    },
    healthy: { label: "Healthy", icon: CircleCheck, tone: "success" },
    paused: { label: "Paused", icon: CircleSlash, tone: "warning" },
  };

function healthOf(costExport: CostExport): Health {
  if (!costExport.enabled) return "paused";
  if (costExport.lastRunStatus === "failed") return "failing";
  if (!costExport.lastRunAt) return "waiting";
  return "healthy";
}

function periodMs(costExport: CostExport): number {
  return costExport.schedule === "daily" ? DAY_MS : HOUR_MS;
}

/** Start of the period `at` falls in, in UTC. */
function periodStart(at: number, costExport: CostExport): number {
  const date = new Date(at);
  date.setUTCMinutes(0, 0, 0);
  if (costExport.schedule === "daily") date.setUTCHours(0);
  return date.getTime();
}

/** Completed periods that are due but not yet written. */
function periodsBehind(costExport: CostExport, now: number): number {
  const latestEnd = periodStart(now - SETTLE_MS, costExport);
  const through = new Date(costExport.exportedThrough).getTime();
  return Math.max(0, Math.floor((latestEnd - through) / periodMs(costExport)));
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const UTC_DATE_TIME = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const UTC_TIME = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const UTC_DATE = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function utcDateTime(at: number | string): string {
  return `${UTC_DATE_TIME.format(new Date(at))} UTC`;
}

/** "14:00–15:00 UTC" for an hour, "Nov 10 UTC" for a day. */
function periodLabel(start: number, costExport: CostExport): string {
  if (costExport.schedule === "daily") {
    return `${UTC_DATE.format(new Date(start))} UTC`;
  }
  return `${UTC_TIME.format(new Date(start))}–${UTC_TIME.format(new Date(start + HOUR_MS))} UTC`;
}

function behindLabel(count: number, costExport: CostExport): string {
  const unit = costExport.schedule === "daily" ? "day" : "hour";
  return `${count} ${unit}${count === 1 ? "" : "s"} behind`;
}

// ===================================================================
// Cells
// ===================================================================

function HealthReading({
  health,
  className,
}: {
  health: Health;
  className?: string;
}) {
  const { label, icon: Icon, tone } = HEALTH[health];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap text-sm",
        TONE_CLASSES[tone],
        className,
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {label}
    </span>
  );
}

function FilterOption({
  icon,
  count,
  children,
}: {
  icon: React.ReactNode;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {icon}
      </span>
      <span>{children}</span>
      {count !== undefined && (
        <span className="tabular-nums text-muted-foreground">{count}</span>
      )}
    </span>
  );
}

function FilterIcon() {
  return <ListFilter aria-hidden className="size-3.5 text-muted-foreground" />;
}

function DestinationCell({ row }: { row: Row }) {
  const { costExport, provider } = row;
  const root = provider ? blobProviderLocation(provider).uri : "";
  const path = `${root}${costExport.pathPrefix ? `${costExport.pathPrefix}/` : ""}`;
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5 text-sm leading-5">
        {provider && <BlobProviderLogo type={provider.type} size={14} />}
        <span className="truncate">{costExport.blobProviderName}</span>
      </div>
      <div
        className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
        title={path}
      >
        {path || costExport.pathPrefix || "/"}
      </div>
    </div>
  );
}

function StatusCell({
  row,
  onRetry,
  onFixDestination,
  retryDisabled,
  running,
}: {
  row: Row;
  onRetry: () => void;
  /** Absent when the destination is unknown to this viewer. */
  onFixDestination?: () => void;
  retryDisabled: boolean;
  running: boolean;
}) {
  const { costExport, health } = row;

  if (health === "failing") {
    const error = costExport.lastRunError || "The last run failed.";
    return (
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <HealthReading health="failing" className="shrink-0" />
          {running ? (
            <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
              <Loader2 aria-hidden className="size-3 animate-spin" />
              Retrying…
            </span>
          ) : (
            <RowClickShield className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs">
              {onFixDestination && (
                <>
                  <UnstyledButton onClick={onFixDestination} className={LINK}>
                    Fix destination
                  </UnstyledButton>
                  <span aria-hidden className="text-muted-foreground">
                    ·
                  </span>
                </>
              )}
              <UnstyledButton
                onClick={onRetry}
                disabled={retryDisabled}
                className={LINK}
              >
                Retry
              </UnstyledButton>
            </RowClickShield>
          )}
        </div>
        <HoverCard openDelay={150} closeDelay={100}>
          <HoverCardTrigger asChild>
            <p
              // biome-ignore lint/a11y/noNoninteractiveTabindex: focus opens the error card for keyboard users
              tabIndex={0}
              className="mt-0.5 cursor-help truncate pl-5 text-xs text-red-700/80 underline decoration-dotted underline-offset-2 outline-none dark:text-red-400/80"
            >
              {error}
            </p>
          </HoverCardTrigger>
          <HoverCardContent align="start" className="w-96 space-y-3">
            <div className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-red-700 dark:text-red-400" />
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">
                  {costExport.blobProviderName} rejected the last write
                </p>
                <p className="text-xs text-muted-foreground">
                  {costExport.lastRunAt
                    ? `Attempted ${formatRelativeTimeFromNow(costExport.lastRunAt)} · ${utcDateTime(costExport.lastRunAt)}`
                    : "No successful run yet"}
                </p>
              </div>
            </div>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/50 p-2 font-mono text-xs leading-relaxed">
              {error}
            </pre>
            <p className="text-xs text-muted-foreground">
              Files before {utcDateTime(costExport.exportedThrough)} are safe.
              It retries from there on its own, less often the longer it fails
              (up to hourly). Fix the destination, then use Retry to confirm.
            </p>
          </HoverCardContent>
        </HoverCard>
      </div>
    );
  }

  const detail =
    health === "healthy"
      ? `Last file ${formatRelativeTimeFromNow(costExport.lastRunAt, { strict: true })}`
      : health === "paused"
        ? "Not writing new files"
        : "Scheduled, nothing written yet";

  return (
    <div className="min-w-0">
      <HealthReading health={health} />
      <p className="mt-0.5 truncate pl-5 text-xs text-muted-foreground">
        {detail}
      </p>
    </div>
  );
}

function WrittenThroughCell({ row, now }: { row: Row; now: number }) {
  const { costExport, health } = row;
  if (health === "waiting") {
    return (
      <div className="min-w-0">
        <div className="text-sm leading-5 text-muted-foreground">
          Nothing yet
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          Starts {utcDateTime(costExport.exportedThrough)}
        </div>
      </div>
    );
  }
  const behind = periodsBehind(costExport, now);
  // One period behind is the normal gap between "due" and the next tick.
  const lagging =
    health !== "paused" &&
    (behind >= 2 || (health === "failing" && behind >= 1));
  return (
    <div
      className="min-w-0"
      title={new Date(costExport.exportedThrough).toISOString()}
    >
      <div
        className={cn(
          "truncate text-sm leading-5",
          lagging && TONE_CLASSES.warning,
        )}
      >
        {formatRelativeTimeFromNow(costExport.exportedThrough, {
          strict: true,
        })}
      </div>
      <div className="mt-0.5 truncate text-xs text-muted-foreground">
        {lagging
          ? behindLabel(behind, costExport)
          : utcDateTime(costExport.exportedThrough)}
      </div>
    </div>
  );
}

/** When the scheduler next retries a failing export (it backs off). */
function retryLabel(nextRetryAt: string | null, now: number): string {
  if (!nextRetryAt || new Date(nextRetryAt).getTime() <= now) {
    return "Retrying soon";
  }
  return `Retry ${formatRelativeTimeFromNow(nextRetryAt, { strict: true })}`;
}

function NextFileCell({
  row,
  now,
  running,
}: {
  row: Row;
  now: number;
  running: boolean;
}) {
  const { costExport, health } = row;
  if (running) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Writing now…
      </span>
    );
  }
  if (health === "paused") {
    return (
      <div className="min-w-0 text-muted-foreground">
        <div className="text-sm leading-5">Paused</div>
        <div className="mt-0.5 truncate text-xs">Resume to continue</div>
      </div>
    );
  }
  const start = new Date(costExport.exportedThrough).getTime();
  const due = start + periodMs(costExport) + SETTLE_MS;
  const overdue = due <= now;
  return (
    <div className="min-w-0">
      <div
        className={cn(
          "flex items-center gap-1.5 text-sm leading-5",
          overdue && health === "failing" && TONE_CLASSES.danger,
        )}
      >
        <CalendarClock
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="truncate">
          {overdue
            ? health === "failing"
              ? retryLabel(costExport.nextRetryAt, now)
              : "Catching up"
            : formatRelativeTimeFromNow(new Date(due), { strict: true })}
        </span>
      </div>
      <div className="mt-0.5 truncate pl-5 text-xs text-muted-foreground">
        {periodLabel(start, costExport)}
      </div>
    </div>
  );
}
