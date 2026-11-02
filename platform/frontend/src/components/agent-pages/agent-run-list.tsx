"use client";

import type {
  CellContext,
  ColumnDef,
  SortingState,
} from "@tanstack/react-table";
import {
  ChevronDown,
  Copy,
  FolderX,
  type LucideIcon,
  Square,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
} from "react";
import { toast } from "sonner";
import { AgentNameCell } from "@/components/agent-name-cell";
import {
  type RunAction,
  runActionConfirmCopy,
} from "@/components/agent-pages/agent-run-actions-copy";
import {
  openRowOnPlainClick,
  RowClickShield,
} from "@/components/agent-pages/row-click-shield";
import { AgentRunState } from "@/components/agent-run-state";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { SearchInput } from "@/components/search-input";
import { SortableHeader } from "@/components/sortable-header";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { BulkActionsScope } from "@/components/ui/bulk-actions-context";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PermissionButton } from "@/components/ui/permission-button";
import { runStatusMarks } from "@/lib/agent-run-status-marks";
import {
  type AgentRunListItem,
  useBulkCancelAgentRuns,
  useBulkDeleteAgentRuns,
  useBulkDeleteAgentWorkspaces,
} from "@/lib/agent-runtime.query";
import { copyToClipboard } from "@/lib/clipboard";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import { useIsMobile } from "@/lib/hooks/use-mobile";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";

/**
 * Every run of one Agent, with the viewer's own runs selectable for Stop and
 * Delete. Opening a row hands its run to `runHref`'s page.
 */
export function AgentRunList({
  runs,
  viewerId,
  runHref,
  onOpen,
  isLoading = false,
}: {
  runs: AgentRunListItem[];
  viewerId: string | undefined;
  runHref: (runId: string) => string;
  onOpen: (runId: string) => void;
  isLoading?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [starter, setStarter] = useState(ANYONE);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 });
  const [sorting, setSorting] = useState<SortingState>([
    { id: "startedAt", desc: true },
  ]);
  const bulkCancel = useBulkCancelAgentRuns();
  const bulkDelete = useBulkDeleteAgentRuns();
  const bulkDeleteFiles = useBulkDeleteAgentWorkspaces();
  const compact = useIsMobile();
  // What a dialog acts on is fixed when it opens: the list refreshes every few
  // seconds, and a run that ends meanwhile must not change what Confirm sends.
  const [confirming, setConfirming] = useState<Confirming | null>(null);

  const isOwn = useCallback(
    (run: AgentRunListItem) => !!viewerId && run.actorUserId === viewerId,
    [viewerId],
  );
  const query = search.trim().toLowerCase();
  const filtered = runs.filter(
    (run) =>
      (starter === ANYONE || starterKey(run) === starter) &&
      STATUS_MATCHES[status](run) &&
      `${run.title} ${run.sessionId} ${run.taskId} ${initiatorLabel(run)}`
        .toLowerCase()
        .includes(query),
  );
  const hasActiveFilters = !!query || starter !== ANYONE || status !== "all";
  const clearFilters = () => {
    setSearch("");
    setStarter(ANYONE);
    setStatus("all");
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  };
  const {
    rowSelection,
    setRowSelection,
    onPageRowIdsChange,
    clearSelection,
    selected,
    selectAllMatching,
  } = useBulkSelection({
    rows: filtered,
    getId: (run) => run.sessionId,
    canSelect: isOwn,
    filterSignature: JSON.stringify({ query, starter, status }),
    matchDescription: hasActiveFilters ? "match the filters" : "exist",
  });
  const active = selected.filter(isLive);
  const ended = selected.filter((run) => !isLive(run));
  const withFiles = ended.filter(hasSavedFiles);
  // Only runs the viewer started can be stopped or deleted, so a viewer who
  // started none of these gets no selection column at all.
  const canSelectAny = runs.some(isOwn);

  const starters = Array.from(
    new Map(runs.map((run) => [starterKey(run), run])).entries(),
  ).map(([key, run]) => ({
    value: key,
    label: isOwn(run) ? "Started by me" : `Started by ${initiatorLabel(run)}`,
  }));

  const confirmRow = (action: RunAction, run: AgentRunListItem) =>
    setConfirming({
      action,
      runIds: [run.sessionId],
      selected: 1,
      clearsSelection: false,
    });
  // Like the other tables, a row shows the actions that fit its run as
  // buttons and leaves out the rest: Stop while the run is live, and Delete
  // saved files and Delete run after it ends, for the person who started it.
  const rowActions = (run: AgentRunListItem) => {
    const own = isOwn(run);
    const live = isLive(run);
    const actions: TableRowAction[] = [
      {
        icon: <Copy className="h-4 w-4" />,
        label: "Copy run ID",
        onClick: () => {
          void copyToClipboard(run.sessionId).then(
            () => toast.success("Run ID copied"),
            () => toast.error("Could not copy run ID"),
          );
        },
      },
    ];
    if (own && live)
      actions.push({
        icon: <Square className="h-4 w-4 fill-current" />,
        label: "Stop run",
        onClick: () => confirmRow("stop", run),
      });
    if (own && !live && hasSavedFiles(run))
      actions.push({
        icon: <FolderX className="h-4 w-4" />,
        label: "Delete saved files",
        onClick: () => confirmRow("files", run),
      });
    if (own && !live)
      actions.push({
        icon: <Trash2 className="h-4 w-4" />,
        label: "Delete run",
        variant: "destructive",
        onClick: () => confirmRow("delete", run),
      });
    // A phone keeps the row's width for the title, so the buttons fold into
    // one menu there.
    return compact ? (
      <TableRowActions
        itemName={run.title}
        actions={[]}
        dropdownActions={actions}
      />
    ) : (
      <TableRowActions itemName={run.title} actions={actions} />
    );
  };

  // TanStack renders headers and cells as components: built anew on each
  // render, they would remount every few seconds as the list refreshes, and
  // take keyboard focus off a sort button or a checkbox.
  const columns = useMemo<ColumnDef<AgentRunListItem>[]>(
    () => [
      ...(canSelectAny
        ? [
            createSelectColumn<AgentRunListItem>({
              rowLabel: (run) => `Select ${run.title}`,
              allLabel: "Select all runs on this page",
              canSelect: isOwn,
              disabledReason: () =>
                "Only the person who started this run can stop or delete it",
            }),
          ]
        : []),
      {
        id: "title",
        accessorFn: (run) => run.title.toLowerCase(),
        header: ({ column }) => <SortableHeader column={column} label="Run" />,
        cell: RunTitleCell,
      },
      {
        id: "status",
        header: "Status",
        size: 220,
        enableSorting: false,
        cell: RunStatusCell,
      },
      {
        id: "startedAt",
        accessorFn: (run) => run.startedAt,
        header: ({ column }) => (
          <SortableHeader column={column} label="Started" />
        ),
        // Fits the longest relative time, "less than a minute ago".
        size: 180,
        cell: ({ row }) => (
          <time
            dateTime={row.original.startedAt}
            title={new Date(row.original.startedAt).toLocaleString()}
            className="whitespace-nowrap text-sm text-muted-foreground"
          >
            {startedAgo(row.original)}
          </time>
        ),
      },
      {
        id: "actions",
        header: () => (
          <span className={compact ? "sr-only" : "block text-right"}>
            Actions
          </span>
        ),
        enableHiding: false,
        enableSorting: false,
        // At most three buttons: Copy run ID, then Stop run, or Delete saved
        // files and Delete run. A phone shows one menu button.
        size: compact ? 64 : 128,
        cell: RunActionsCell,
      },
    ],
    [canSelectAny, compact, isOwn],
  );

  // Each bulk action reaches only the selected runs it fits; its dialog
  // names how many, and Delete says which runs it leaves running.
  const targets: Record<RunAction, AgentRunListItem[]> = {
    stop: active,
    files: withFiles,
    delete: ended,
  };
  const confirmBulk = (action: RunAction) =>
    setConfirming({
      action,
      runIds: targets[action].map((run) => run.sessionId),
      selected: selected.length,
      clearsSelection: targets[action].length === selected.length,
    });
  const runIds = confirming?.runIds ?? [];
  // Runs the action leaves alone stay selected for the next one. A dialog
  // closed while its action ran must not close the one opened after it.
  const finish = (dialog: Confirming) => (outcome: { failed: unknown[] }) => {
    if (dialog.clearsSelection && outcome.failed.length === 0) clearSelection();
    setConfirming((current) => (current === dialog ? null : current));
  };
  // Every bulk action shows while runs are selected, like the row's buttons;
  // one that fits none of them stays disabled and says what to select.
  const actions: BulkAction[] = [
    {
      key: "stop",
      label: "Stop",
      icon: Square,
      // Filled, so it reads as stop beside the selection checkboxes.
      iconClassName: "fill-current",
      disabledReason: active.length
        ? null
        : "Select a run that is still running",
    },
    {
      key: "files",
      label: "Delete saved files",
      icon: FolderX,
      disabledReason: withFiles.length
        ? null
        : "Select a finished run that has saved files",
    },
    {
      key: "delete",
      label: "Delete",
      icon: Trash2,
      destructive: true,
      disabledReason: ended.length ? null : "Select a finished run",
    },
  ];
  const confirmCopy = confirming
    ? runActionConfirmCopy({
        action: confirming.action,
        count: runIds.length,
        selected: confirming.selected,
      })
    : null;
  const mutations = {
    stop: bulkCancel,
    files: bulkDeleteFiles,
    delete: bulkDelete,
  };

  return (
    <RunListContext.Provider value={{ isOwn, runHref, rowActions }}>
      <BulkActionsScope>
        <CollectionFilters>
          <FilterBar
            leading
            onClearFilters={hasActiveFilters ? clearFilters : undefined}
            search={
              <SearchInput
                objectNamePlural="runs"
                searchFields={["title", "ID"]}
                value={search}
                onSearchChange={(value) => {
                  setSearch(value);
                  setPagination((current) => ({ ...current, pageIndex: 0 }));
                }}
                syncQueryParams={false}
                className={filterSearchClass}
              />
            }
          >
            <FilterSelect
              value={status}
              onValueChange={(value) => {
                setStatus(value as StatusFilter);
                setPagination((current) => ({ ...current, pageIndex: 0 }));
              }}
              placeholder="Filter by status"
              inactiveValue="all"
              items={STATUS_ITEMS}
            />
            {starters.length > 1 && (
              <FilterSelect
                value={starter}
                onValueChange={(value) => {
                  setStarter(value);
                  setPagination((current) => ({ ...current, pageIndex: 0 }));
                }}
                placeholder="Filter by who started it"
                inactiveValue={ANYONE}
                items={[
                  { value: ANYONE, label: "Started by anyone" },
                  ...starters,
                ]}
              />
            )}
          </FilterBar>
        </CollectionFilters>

        {canSelectAny && (
          <BulkActions
            count={selected.length}
            noun="run"
            onClear={clearSelection}
            selectAllMatching={selectAllMatching}
            busy={
              bulkCancel.isPending ||
              bulkDelete.isPending ||
              bulkDeleteFiles.isPending
            }
          >
            {/* A phone has room for one action; the three fold into a menu. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="sm:hidden">
                  <span>Actions</span>
                  <ChevronDown />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {actions.map((action) => (
                  <BulkMenuItem
                    key={action.key}
                    action={action}
                    onSelect={() => confirmBulk(action.key)}
                  />
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {actions.map((action) => (
              <PermissionButton
                key={action.key}
                // Run actions are checked by who started the run, not by role.
                permissions={{}}
                disabled={!!action.disabledReason}
                tooltip={action.disabledReason ?? undefined}
                variant={action.destructive ? "destructive" : "outline"}
                size="sm"
                className="max-sm:hidden"
                onClick={() => confirmBulk(action.key)}
              >
                <action.icon className={action.iconClassName} />
                <span>{action.label}</span>
              </PermissionButton>
            ))}
          </BulkActions>
        )}

        <DataTable
          columns={columns}
          data={filtered}
          getRowId={(run) => run.sessionId}
          rowSelection={canSelectAny ? rowSelection : undefined}
          onRowSelectionChange={canSelectAny ? setRowSelection : undefined}
          onPageRowIdsChange={onPageRowIdsChange}
          hideSelectedCount
          pagination={{ ...pagination, total: filtered.length }}
          onPaginationChange={setPagination}
          sorting={sorting}
          onSortingChange={setSorting}
          onRowClick={(run, event) =>
            openRowOnPlainClick(event, () => onOpen(run.sessionId))
          }
          isLoading={isLoading}
          emptyIcon={TerminalSquare}
          emptyMessage="No runs yet"
          hasActiveFilters={hasActiveFilters}
          filteredEmptyMessage="No runs match your filters"
          onClearFilters={clearFilters}
          fixedWidthColumnIds={["status", "startedAt"]}
          flexibleColumnIds={["title"]}
          columnDropOrder={["startedAt", "status"]}
        />

        {confirming && confirmCopy && (
          <DeleteConfirmDialog
            open
            onOpenChange={(open) => !open && setConfirming(null)}
            title={confirmCopy.title}
            description={confirmCopy.description}
            confirmLabel={confirmCopy.confirmLabel}
            pendingLabel={
              confirming.action === "stop" ? "Stopping…" : "Deleting…"
            }
            isPending={mutations[confirming.action].isPending}
            onConfirm={() =>
              mutations[confirming.action].mutate(runIds, {
                onSuccess: finish(confirming),
              })
            }
          />
        )}
      </BulkActionsScope>
    </RunListContext.Provider>
  );
}

export function starterKey(run: AgentRunListItem): string {
  return `${run.actorKind}:${run.actorId}`;
}

export function initiatorLabel(run: AgentRunListItem): string {
  if (run.initiatorName) return run.initiatorName;
  if (run.actorKind === "serviceAccount") return "a service account";
  if (run.actorKind === "organization") return "the organization";
  if (run.actorKind === "team") return "a team";
  if (run.actorKind === "system") return "automation";
  return "an unknown user";
}

// TanStack renders each cell as a component, and the list refreshes every few
// seconds: a cell defined inline would remount on each refresh and close an
// open row menu or status popover. These keep one identity, and the context
// hands them this render's helpers.
const RunListContext = createContext<{
  isOwn: (run: AgentRunListItem) => boolean;
  runHref: (runId: string) => string;
  rowActions: (run: AgentRunListItem) => ReactNode;
} | null>(null);

function useRunList() {
  const context = useContext(RunListContext);
  if (!context) throw new Error("A run list cell rendered outside its list");
  return context;
}

function RunTitleCell({ row, table }: CellContext<AgentRunListItem, unknown>) {
  const { isOwn, runHref } = useRunList();
  const run = row.original;
  const startedBy = `Started by ${isOwn(run) ? "you" : initiatorLabel(run)}`;
  // A narrow table drops the Started and then the Status column. Their facts
  // move into the row: its age into the subline, and its status into the
  // subline and the icon, which turns into the run's state icon.
  const hidden = (id: string) => table.getColumn(id)?.getIsVisible() === false;
  const narrow = hidden("status");
  const marks = runStatusMarks(run);
  const subline = hidden("startedAt")
    ? `${startedBy}, ${startedAgo(run)}`
    : startedBy;
  return (
    <AgentNameCell
      name={run.title}
      href={runHref(run.sessionId)}
      icon={
        narrow ? (
          <AgentRunState {...run} iconOnly />
        ) : (
          <TerminalSquare className="size-5 text-muted-foreground" />
        )
      }
      description={
        narrow ? `${marks.chip?.label ?? marks.label} · ${subline}` : subline
      }
    />
  );
}

function RunStatusCell({ row }: CellContext<AgentRunListItem, unknown>) {
  return (
    <RowClickShield className="inline-flex">
      <RunStatus run={row.original} />
    </RowClickShield>
  );
}

function RunActionsCell({ row }: CellContext<AgentRunListItem, unknown>) {
  const { rowActions } = useRunList();
  return (
    <RowClickShield className="flex justify-end">
      {rowActions(row.original)}
    </RowClickShield>
  );
}

function RunStatus({ run }: { run: AgentRunListItem }) {
  // The whole run, as the narrow title cell passes it, so both show the same
  // status, attention included.
  return <AgentRunState {...run} />;
}

/**
 * A bulk action in the phone's Actions menu. One that fits none of the
 * selected runs stays in the menu with its reason under the label: a phone
 * has no hover for a tooltip. `aria-disabled` rather than Radix's `disabled`,
 * which would take the item, and its reason, out of keyboard reach.
 */
function BulkMenuItem({
  action,
  onSelect,
}: {
  action: BulkAction;
  onSelect: () => void;
}) {
  const reasonId = useId();
  const disabled = !!action.disabledReason;
  return (
    <DropdownMenuItem
      aria-disabled={disabled || undefined}
      aria-describedby={disabled ? reasonId : undefined}
      variant={action.destructive ? "destructive" : "default"}
      className={disabled ? "cursor-not-allowed items-start" : undefined}
      onSelect={(event) => {
        if (disabled) event.preventDefault();
        else onSelect();
      }}
    >
      <action.icon
        className={cn(action.iconClassName, disabled && "mt-0.5 opacity-50")}
      />
      <span className="flex flex-col">
        <span className={disabled ? "opacity-50" : undefined}>
          {action.label}
        </span>
        {disabled && (
          <span
            id={reasonId}
            aria-hidden="true"
            className="text-xs text-muted-foreground"
          >
            {action.disabledReason}
          </span>
        )}
      </span>
    </DropdownMenuItem>
  );
}

type Confirming = {
  action: RunAction;
  runIds: string[];
  /** How many runs were selected. The action can reach only some of them. */
  selected: number;
  /** A bulk action that reaches the whole selection clears it when done. */
  clearsSelection: boolean;
};

type BulkAction = {
  key: RunAction;
  label: string;
  icon: LucideIcon;
  iconClassName?: string;
  destructive?: boolean;
  disabledReason: string | null;
};

const ANYONE = "anyone";

type StatusFilter = "all" | "running" | "ended" | "failed";

const STATUS_ITEMS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "running", label: "Running" },
  { value: "ended", label: "Ended" },
  { value: "failed", label: "Failed" },
];

const STATUS_MATCHES: Record<StatusFilter, (run: AgentRunListItem) => boolean> =
  {
    all: () => true,
    running: (run) => run.endedAt === null,
    ended: (run) => run.endedAt !== null,
    failed: (run) => run.state === "TASK_STATE_FAILED",
  };

function startedAgo(run: AgentRunListItem) {
  return formatRelativeTimeFromNow(run.startedAt, { strict: true });
}

function isLive(run: AgentRunListItem) {
  return run.endedAt === null;
}

/** The run page offers "Delete saved files" in the same workspace states. */
function hasSavedFiles(run: AgentRunListItem) {
  return (
    !!run.workspace &&
    ["idle", "suspended", "deleting"].includes(run.workspace.state)
  );
}
