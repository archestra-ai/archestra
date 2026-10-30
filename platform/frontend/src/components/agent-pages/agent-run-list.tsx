"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Square, TerminalSquare, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
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
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { BulkActionsScope } from "@/components/ui/bulk-actions-context";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  type AgentRunListItem,
  useBulkCancelAgentRuns,
  useBulkDeleteAgentRuns,
} from "@/lib/agent-runtime.query";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

/**
 * Every run of one Agent, with the viewer's own runs selectable for Stop and
 * Delete. Opening a row hands its run to `runHref`'s page.
 */
export function AgentRunList({
  runs,
  viewerId,
  runHref,
  onOpen,
}: {
  runs: AgentRunListItem[];
  viewerId: string | undefined;
  runHref: (taskId: string) => string;
  onOpen: (taskId: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [starter, setStarter] = useState(ANYONE);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });
  const bulkCancel = useBulkCancelAgentRuns();
  const bulkDelete = useBulkDeleteAgentRuns();
  const [confirming, setConfirming] = useState<"stop" | "delete" | null>(null);

  const isOwn = (run: AgentRunListItem) =>
    !!viewerId && run.actorUserId === viewerId;
  const query = search.trim().toLowerCase();
  const filtered = runs.filter(
    (run) =>
      (starter === ANYONE || starterKey(run) === starter) &&
      STATUS_MATCHES[status](run) &&
      `${run.title} ${run.taskId} ${initiatorLabel(run)}`
        .toLowerCase()
        .includes(query),
  );
  const hasActiveFilters = !!query || starter !== ANYONE || status !== "all";
  const clearFilters = () => {
    setSearch("");
    setStarter(ANYONE);
    setStatus("all");
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
    getId: (run) => run.taskId,
    canSelect: isOwn,
    filterSignature: JSON.stringify({ query, starter, status }),
    matchDescription: hasActiveFilters ? "match the filters" : "exist",
  });
  const active = selected.filter((run) => run.endedAt === null);
  const ended = selected.filter((run) => run.endedAt !== null);
  // Only runs the viewer started can be stopped or deleted, so a viewer who
  // started none of these gets no selection column at all.
  const canSelectAny = runs.some(isOwn);

  const starters = Array.from(
    new Map(runs.map((run) => [starterKey(run), run])).entries(),
  ).map(([key, run]) => ({
    value: key,
    label: isOwn(run) ? "Started by me" : `Started by ${initiatorLabel(run)}`,
  }));

  const columns: ColumnDef<AgentRunListItem>[] = [
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
      header: "Run",
      enableSorting: false,
      cell: ({ row, table }) => {
        const run = row.original;
        // A narrow table drops its columns; what they held moves under the
        // title so each row still says how the run went and who started it.
        const hidden = (id: string) =>
          table.getColumn(id)?.getIsVisible() === false;
        const meta = [
          hidden("startedBy")
            ? isOwn(run)
              ? "You"
              : initiatorLabel(run)
            : null,
          hidden("startedAt") ? startedAgo(run) : null,
        ].filter(Boolean);
        return (
          <div className="min-w-0">
            <RowClickShield className="min-w-0">
              <Link
                href={runHref(run.taskId)}
                className="block truncate font-medium hover:underline"
              >
                {run.title}
              </Link>
            </RowClickShield>
            {(hidden("status") || meta.length > 0) && (
              <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                {hidden("status") && (
                  <RowClickShield className="inline-flex shrink-0">
                    <RunStatus run={run} />
                  </RowClickShield>
                )}
                {meta.length > 0 && (
                  <span className="truncate">{meta.join(", ")}</span>
                )}
              </div>
            )}
          </div>
        );
      },
    },
    {
      id: "status",
      header: "Status",
      size: 200,
      enableSorting: false,
      cell: ({ row }) => (
        <RowClickShield className="inline-flex">
          <RunStatus run={row.original} />
        </RowClickShield>
      ),
    },
    {
      id: "startedBy",
      header: "Started by",
      size: 160,
      enableSorting: false,
      cell: ({ row }) => (
        <span className="block truncate text-muted-foreground">
          {isOwn(row.original) ? "You" : initiatorLabel(row.original)}
        </span>
      ),
    },
    {
      id: "startedAt",
      header: () => <span className="block text-right">Started</span>,
      size: 140,
      enableSorting: false,
      cell: ({ row }) => (
        <time
          dateTime={row.original.startedAt}
          title={new Date(row.original.startedAt).toLocaleString()}
          className="block whitespace-nowrap text-right tabular-nums text-muted-foreground"
        >
          {startedAgo(row.original)}
        </time>
      ),
    },
  ];

  const deleteCount = ended.length;
  const stopCount = active.length;
  // A mixed selection names how many each action reaches, so Delete never
  // looks like it will take the runs that are still going.
  const mixed = deleteCount > 0 && stopCount > 0;

  return (
    <BulkActionsScope>
      <CollectionFilters>
        <FilterBar
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
          busy={bulkCancel.isPending || bulkDelete.isPending}
        >
          {stopCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirming("stop")}
            >
              <Square className="fill-current max-sm:hidden" />
              <span>{mixed ? `Stop ${stopCount}` : "Stop"}</span>
            </Button>
          )}
          {deleteCount > 0 && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirming("delete")}
            >
              <Trash2 className="max-sm:hidden" />
              <span>{mixed ? `Delete ${deleteCount}` : "Delete"}</span>
            </Button>
          )}
        </BulkActions>
      )}

      <DataTable
        columns={columns}
        data={filtered}
        getRowId={(run) => run.taskId}
        rowSelection={canSelectAny ? rowSelection : undefined}
        onRowSelectionChange={canSelectAny ? setRowSelection : undefined}
        onPageRowIdsChange={onPageRowIdsChange}
        hideSelectedCount
        pagination={{ ...pagination, total: filtered.length }}
        onPaginationChange={setPagination}
        hidePaginationWhenSinglePage
        onRowClick={(run, event) =>
          openRowOnPlainClick(event, () => onOpen(run.taskId))
        }
        emptyIcon={TerminalSquare}
        emptyMessage="No runs yet"
        hasActiveFilters={hasActiveFilters}
        filteredEmptyMessage="No runs match your filters"
        onClearFilters={clearFilters}
        fixedWidthColumnIds={["status", "startedBy", "startedAt"]}
        flexibleColumnIds={["title"]}
        columnDropOrder={["startedBy", "startedAt", "status"]}
      />

      <DeleteConfirmDialog
        open={confirming === "stop"}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={`Stop ${countOf(stopCount)}?`}
        description={`The Agent ${
          stopCount === 1 ? "process" : "processes"
        } will stop. Saved files and run history will be retained so you can continue later.`}
        confirmLabel={stopCount === 1 ? "Stop run" : "Stop runs"}
        pendingLabel="Stopping…"
        isPending={bulkCancel.isPending}
        onConfirm={() =>
          bulkCancel.mutate(
            active.map((run) => run.taskId),
            {
              onSuccess: (outcome) => {
                setConfirming(null);
                if (outcome.failed.length === 0) clearSelection();
              },
            },
          )
        }
      />
      <DeleteConfirmDialog
        open={confirming === "delete"}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={`Delete ${countOf(deleteCount)}?`}
        description={`This removes ${
          deleteCount === 1 ? "the session and its" : "their sessions and"
        } retained output. This action cannot be undone.${
          stopCount === 1
            ? " The run that is still running is not deleted."
            : stopCount > 1
              ? ` The ${stopCount} runs that are still running are not deleted.`
              : ""
        }`}
        confirmLabel={deleteCount === 1 ? "Delete run" : "Delete runs"}
        pendingLabel="Deleting…"
        isPending={bulkDelete.isPending}
        onConfirm={() =>
          bulkDelete.mutate(
            ended.map((run) => run.taskId),
            {
              onSuccess: (outcome) => {
                setConfirming(null);
                if (outcome.failed.length === 0 && stopCount === 0) {
                  clearSelection();
                }
              },
            },
          )
        }
      />
    </BulkActionsScope>
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

function RunStatus({ run }: { run: AgentRunListItem }) {
  return (
    <AgentRunState
      state={run.state}
      statusReason={run.statusReason}
      startedAt={run.startedAt}
      endedAt={run.endedAt}
      hardDeadlineAt={run.hardDeadlineAt}
      lastModelActivityAt={run.lastModelActivityAt}
      compact
    />
  );
}

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

function countOf(count: number) {
  return `${count} ${count === 1 ? "run" : "runs"}`;
}
