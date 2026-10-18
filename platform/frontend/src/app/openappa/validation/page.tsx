"use client";

import type { CellContext, ColumnDef } from "@tanstack/react-table";
import {
  ChevronDown,
  Download,
  Eye,
  Info,
  Loader2,
  Pencil,
  Play,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { createContext, useContext, useMemo, useState } from "react";
import {
  openRowOnPlainClick,
  RowClickShield,
} from "@/components/agent-pages/row-click-shield";
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
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { formatDate } from "@/lib/utils/date-time";
import { OpenAppaPageAction } from "../_parts/openappa-page-action";
import {
  type ValidationFileState,
  validationFileStates,
  validationName,
} from "../_parts/validation-run-history";
import { useValidation, validationFileHref } from "./_parts/validation-context";
import {
  exportValidationFile,
  statusLabel,
  ValidationLastRun,
  ValidationNotices,
  ValidationPageActions,
  ValidationRunNotices,
  ValidationStatusBadge,
} from "./_parts/validation-parts";

const statuses = [
  { value: "all", label: "All statuses" },
  { value: "passed", label: "Passed" },
  { value: "failed", label: "Failed" },
  { value: "cannot_run", label: "Cannot run" },
  { value: "not_run", label: "Not run" },
];
type ValidationRow = {
  file: { path: string; content: string };
  id: string;
  name: string;
  /** Unknown while the file's content is still being hashed. */
  status: ValidationFileState["status"] | null;
  lastRunAt: string | null;
  /** What kind of run recorded the status, e.g. "Single file run". */
  runLabel: string | null;
  error?: string | null;
};

export default function ValidationPage() {
  const suite = useValidation();
  const router = useRouter();
  const params = useSearchParams();
  const [deleteIds, setDeleteIds] = useState<string[]>([]);
  const [pageIds, setPageIds] = useState<string[]>([]);
  const search = params.get("search") ?? "";
  const status =
    statuses.find((item) => item.value === params.get("status"))?.value ??
    "all";
  const pageSize = [10, 20, 30, 40, 50, 100].includes(
    Number(params.get("pageSize")),
  )
    ? Number(params.get("pageSize"))
    : 10;
  const states = suite.history.data
    ? validationFileStates(suite.files, suite.history.data)
    : null;
  const query = search.toLowerCase();
  const filtered = suite.files
    .map((file) => {
      const state = states?.get(file.path);
      return {
        file,
        id: file.path,
        name: validationName(file),
        status: state?.status ?? null,
        lastRunAt: state?.runAt ?? null,
        runLabel: state?.runLabel ?? null,
        error:
          state?.error ||
          suite.summaries?.find((item) => item.path === file.path)?.error,
      } satisfies ValidationRow;
    })
    .filter(
      (row) =>
        (row.name.toLowerCase().includes(query) ||
          row.file.path.toLowerCase().includes(query)) &&
        (status === "all" || row.status === status),
    );
  const pageIndex = Math.max(
    0,
    Math.min(
      Number(params.get("page")) - 1 || 0,
      Math.ceil(filtered.length / pageSize) - 1,
    ),
  );
  const hasFilters = Boolean(search || status !== "all");
  const canDelete = canDeleteValidations(suite);
  const rowSelection = Object.fromEntries(
    Array.from(suite.selected, (id) => [id, true]),
  );
  function updateQuery(changes: Record<string, string | null>) {
    const query = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) query.delete(key);
      else query.set(key, value);
    }
    router.replace(`/openappa/validation${query.size ? `?${query}` : ""}`, {
      scroll: false,
    });
  }
  function clearFilters() {
    updateQuery({ search: null, status: null, page: null });
  }

  // Cells are module-level components: tanstack renders a cell function as a
  // component, so a closure recreated on each render would remount the cell
  // and close its open popover or menu whenever the page re-renders.
  const selectable = !suite.github && suite.canWrite;
  const busy = suite.busy;
  const columns = useMemo<ColumnDef<ValidationRow>[]>(
    () => [
      ...(selectable
        ? [
            createSelectColumn<ValidationRow>({
              rowLabel: (row) => `Select ${row.file.path}`,
              allLabel: "Select all validations on this page",
              canSelect: () => !busy,
              disabledReason: () => "Wait for the current operation to finish",
            }),
          ]
        : []),
      { id: "name", header: "Name", cell: NameCell },
      { id: "status", header: "Status", cell: StatusColumnCell },
      { id: "lastRunAt", header: "Last run", cell: LastRunCell },
      {
        id: "actions",
        header: "Actions",
        enableHiding: false,
        size: 130,
        cell: ActionsCell,
      },
    ],
    [selectable, busy],
  );
  return (
    <div className="-mt-2 space-y-4">
      <OpenAppaPageAction>
        <ValidationPageActions />
      </OpenAppaPageAction>
      <ValidationNotices hideManagedChip />
      <ValidationRunNotices />
      {suite.inspectionError && (
        <InlineNotice variant="error">
          <Info />
          <span className="font-medium">
            Could not inspect validation files
          </span>
          <InlineNoticeText>{suite.inspectionError.message}</InlineNoticeText>
        </InlineNotice>
      )}
      <DeleteRequestContext.Provider value={setDeleteIds}>
        <BulkActionsScope>
          <CollectionFilters>
            <FilterBar
              leading
              actions={
                <ValidationLastRun files={filtered.map((row) => row.file)} />
              }
              onClearFilters={hasFilters ? clearFilters : undefined}
              search={
                <SearchInput
                  placeholder="Search validations…"
                  className={filterSearchClass}
                />
              }
            >
              <FilterSelect
                ariaLabel="Filter by validation status"
                value={status}
                onValueChange={(value) =>
                  updateQuery({
                    status: value === "all" ? null : value,
                    page: "1",
                  })
                }
                items={statuses}
                placeholder="All statuses"
              />
            </FilterBar>
          </CollectionFilters>
          <BulkActions
            count={suite.selected.size}
            noun="validation"
            onClear={() => suite.setSelected(new Set())}
            busy={suite.busy}
            maxSelection={32}
            selectAllMatching={{
              total: filtered.length,
              pageFullySelected:
                pageIds.length > 0 &&
                pageIds.every((id) => suite.selected.has(id)),
              active:
                filtered.length > 0 &&
                filtered.length === suite.selected.size &&
                filtered.every((row) => suite.selected.has(row.id)),
              onSelectAll: () =>
                suite.setSelected(new Set(filtered.map((row) => row.id))),
            }}
          >
            {!suite.github && suite.canWrite && (
              <Button
                size="sm"
                variant="destructive"
                disabled={!canDelete}
                onClick={() => setDeleteIds(Array.from(suite.selected))}
              >
                <Trash2 />
                <span>Delete</span>
              </Button>
            )}
          </BulkActions>
          <DataTable
            columns={columns}
            data={filtered}
            getRowId={(row) => row.id}
            onRowClick={(row, event) =>
              openRowOnPlainClick(event, () =>
                router.push(validationFileHref(row.file.path)),
              )
            }
            rowSelection={rowSelection}
            onRowSelectionChange={(next) =>
              suite.setSelected(
                new Set(Object.keys(next).filter((id) => next[id])),
              )
            }
            onPageRowIdsChange={setPageIds}
            hideSelectedCount
            tableClassName="min-w-[560px]"
            pagination={{ pageIndex, pageSize, total: filtered.length }}
            onPaginationChange={(next) =>
              updateQuery({
                page: String(next.pageIndex + 1),
                pageSize: String(next.pageSize),
              })
            }
            hasActiveFilters={hasFilters}
            onClearFilters={clearFilters}
            filteredEmptyMessage="No matching validation files."
            emptyMessage="No validation files yet."
            emptyDescription="Ask the agent to write one for a case you want to protect."
          />
        </BulkActionsScope>
      </DeleteRequestContext.Provider>
      <DeleteConfirmDialog
        open={deleteIds.length > 0}
        onOpenChange={(open) => {
          if (!open) setDeleteIds([]);
        }}
        title={`Delete ${deleteIds.length} validation ${deleteIds.length === 1 ? "file" : "files"}?`}
        description="These validation files will be deleted."
        isPending={suite.busy}
        confirmDisabled={!canDelete}
        onConfirm={() => {
          suite.deleteFiles(deleteIds, () => setDeleteIds([]));
        }}
      />
    </div>
  );
}

/** Opens the delete confirmation for the given validation files. */
const DeleteRequestContext = createContext<(ids: string[]) => void>(
  () => undefined,
);

type ValidationCellProps = CellContext<ValidationRow, unknown>;

function canDeleteValidations(suite: ReturnType<typeof useValidation>) {
  return (
    !suite.github &&
    suite.canWrite &&
    !suite.busy &&
    !suite.sourceChanged &&
    !suite.loadError &&
    !suite.collection.error
  );
}

function NameCell({ row }: ValidationCellProps) {
  const { file, name, error } = row.original;
  return (
    <div className="max-w-md">
      <RowClickShield>
        <Link
          className="block truncate font-medium"
          href={validationFileHref(file.path)}
          title={file.path}
        >
          {name}
        </Link>
      </RowClickShield>
      {error && (
        <span
          className="block truncate text-xs text-muted-foreground"
          title={error}
        >
          {error}
        </span>
      )}
    </div>
  );
}

function StatusColumnCell({ row }: ValidationCellProps) {
  const suite = useValidation();
  if (suite.runningPath === row.original.file.path)
    return (
      <ValidationStatusBadge status="running">
        <Loader2 className="animate-spin" />
        <span>Running</span>
      </ValidationStatusBadge>
    );
  if (row.original.status) return <StatusCell row={row.original} />;
  return <span className="text-muted-foreground">—</span>;
}

function LastRunCell({ row }: ValidationCellProps) {
  return (
    <span className="whitespace-nowrap text-sm text-muted-foreground">
      {row.original.lastRunAt
        ? formatDate({ date: row.original.lastRunAt })
        : "—"}
    </span>
  );
}

function ActionsCell({ row }: ValidationCellProps) {
  const suite = useValidation();
  const requestDelete = useContext(DeleteRequestContext);
  const { file, id } = row.original;
  return (
    <RowClickShield>
      <TableRowActions
        itemName={file.path}
        actions={[
          {
            icon:
              suite.runningPath === file.path ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Play />
              ),
            label: "Run",
            tooltip: "Run this validation and record the result",
            permissions: { guardrailsPolicy: ["update"] },
            disabled: !suite.runnable,
            disabledTooltip: suite.busy
              ? "Wait for the current run to finish"
              : "Refresh the page before running",
            onClick: () => suite.runFile(file.path),
          },
          {
            icon: suite.canWrite ? <Pencil /> : <Eye />,
            label: suite.canWrite ? "Edit" : "View",
            href: validationFileHref(file.path),
          },
        ]}
        dropdownActions={[
          {
            icon: <Download />,
            label: "Export",
            onClick: () => exportValidationFile(file),
          },
          ...(!suite.github && suite.canWrite
            ? [
                {
                  icon: <Trash2 />,
                  label: "Delete",
                  variant: "destructive" as const,
                  disabled: !canDeleteValidations(suite),
                  onClick: () => requestDelete([id]),
                },
              ]
            : []),
        ]}
      />
    </RowClickShield>
  );
}

/** A status that did not pass opens its full reason and the run that recorded it. */
function StatusCell({ row }: { row: ValidationRow }) {
  const status = row.status ?? "not_run";
  if (!row.error || status === "passed" || status === "not_run")
    return <ValidationStatusBadge status={status} />;
  return (
    <RowClickShield>
      <Popover>
        <PopoverTrigger asChild>
          <UnstyledButton
            className="rounded-full"
            aria-label={`${statusLabel(status)}: show why`}
          >
            <ValidationStatusBadge status={status}>
              <span>{statusLabel(status)}</span>
              <ChevronDown />
            </ValidationStatusBadge>
          </UnstyledButton>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[28rem] space-y-3">
          <div className="flex items-center gap-2">
            <TriangleAlert
              className={
                status === "failed"
                  ? "size-4 text-red-700 dark:text-red-400"
                  : "size-4 text-yellow-800 dark:text-yellow-300"
              }
              aria-hidden
            />
            <p className="text-sm font-medium">{statusLabel(status)}</p>
            {row.lastRunAt && (
              <p className="ml-auto text-xs text-muted-foreground">
                {[
                  row.runLabel,
                  formatDate({
                    date: row.lastRunAt,
                    dateFormat: "MM/dd HH:mm",
                  }),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            )}
          </div>
          <p className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 font-mono text-xs">
            {row.error}
          </p>
        </PopoverContent>
      </Popover>
    </RowClickShield>
  );
}
