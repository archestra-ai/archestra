"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Download, Eye, Info, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
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
import { formatDate } from "@/lib/utils/date-time";
import { OpenAppaPageAction } from "../_parts/openappa-page-action";
import { useValidationFileHashes } from "../_parts/use-validation-file-hashes";
import {
  type ValidationFileState,
  validationFileStates,
  validationName,
} from "../_parts/validation-run-history";
import { useValidation, validationFileHref } from "./_parts/validation-context";
import {
  exportValidationFile,
  ValidationActions,
  ValidationLastRun,
  ValidationNotices,
  ValidationRunAction,
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
  const hashes = useValidationFileHashes(suite.files);
  const states = hashes.data
    ? validationFileStates(hashes.data, suite.history.data ?? [])
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
  const canDelete =
    !suite.github &&
    suite.canWrite &&
    !suite.busy &&
    !suite.sourceChanged &&
    !suite.loadError &&
    !suite.collection.error;
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
  function fileHref(row: ValidationRow) {
    return validationFileHref(row.file.path);
  }

  const columns: ColumnDef<ValidationRow>[] = [
    ...(!suite.github && suite.canWrite
      ? [
          createSelectColumn<ValidationRow>({
            rowLabel: (row) => `Select ${row.file.path}`,
            allLabel: "Select all validations on this page",
            canSelect: () => !suite.busy,
            disabledReason: () => "Wait for the current operation to finish",
          }),
        ]
      : []),
    {
      id: "name",
      header: "Name",
      cell: ({ row }) => {
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
      },
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) =>
        row.original.status ? (
          <ValidationStatusBadge status={row.original.status} />
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "lastRunAt",
      header: "Last run",
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-sm text-muted-foreground">
          {row.original.lastRunAt
            ? formatDate({ date: row.original.lastRunAt })
            : "—"}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      enableHiding: false,
      size: 130,
      cell: ({ row }) => (
        <RowClickShield>
          <TableRowActions
            itemName={row.original.file.path}
            actions={[
              {
                icon: suite.canWrite ? <Pencil /> : <Eye />,
                label: suite.canWrite ? "Edit" : "View",
                href: fileHref(row.original),
              },
            ]}
            dropdownActions={[
              {
                icon: <Download />,
                label: "Export",
                onClick: () => exportValidationFile(row.original.file),
              },
              ...(!suite.github && suite.canWrite
                ? [
                    {
                      icon: <Trash2 />,
                      label: "Delete",
                      variant: "destructive" as const,
                      disabled: !canDelete,
                      onClick: () => setDeleteIds([row.original.id]),
                    },
                  ]
                : []),
            ]}
          />
        </RowClickShield>
      ),
    },
  ];
  return (
    <div className="-mt-2 space-y-4">
      <OpenAppaPageAction>
        <ValidationRunAction />
      </OpenAppaPageAction>
      <ValidationNotices />
      <ValidationLastRun />
      {suite.inspectionError && (
        <InlineNotice variant="error">
          <Info />
          <span className="font-medium">
            Could not inspect validation files
          </span>
          <InlineNoticeText>{suite.inspectionError.message}</InlineNoticeText>
        </InlineNotice>
      )}
      <BulkActionsScope>
        <CollectionFilters>
          <FilterBar
            leading
            actions={<ValidationActions />}
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
            openRowOnPlainClick(event, () => router.push(fileHref(row)))
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
