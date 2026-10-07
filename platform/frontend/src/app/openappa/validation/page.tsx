"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Download, Eye, Info, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
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
import { formatDate } from "@/lib/utils/date-time";
import { OpenAppaPageAction } from "../_parts/openappa-page-action";
import { useValidation, validationFileHref } from "./validation-context";
import { exportValidationFile } from "./validation-file";
import {
  ValidationActions,
  ValidationLastRun,
  ValidationNotices,
  ValidationRunAction,
  ValidationStatusBadge,
} from "./validation-parts";

const statuses = [
  { value: "all", label: "All statuses" },
  { value: "passed", label: "Passed" },
  { value: "failed", label: "Failed" },
];
type ValidationRow = {
  file: { path: string; content: string };
  id: string;
  status: "passed" | "failed" | null;
  lastRunAt: string | null;
  error?: string | null;
};

export default function ValidationPage() {
  const suite = useValidation();
  const router = useRouter();
  const params = useSearchParams();
  const pathname = usePathname();
  const queryString = params.toString();
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
  const filtered = suite.files
    .map((file, index) => {
      const lastRun = [suite.currentRun, ...(suite.history.data ?? [])].find(
        (run) =>
          run &&
          (run.executionError ||
            run.files.some((result) => result.path === file.path)),
      );
      const result = lastRun?.files.find((item) => item.path === file.path);
      const failedToRun = Boolean(
        lastRun?.executionError || (lastRun && !lastRun.validation.valid),
      );
      return {
        file,
        id: suite.fields[index].id,
        status:
          failedToRun || (result && result.status !== "passed")
            ? "failed"
            : result
              ? "passed"
              : null,
        lastRunAt: lastRun?.createdAt ?? null,
        error:
          result?.error ||
          lastRun?.executionError ||
          (failedToRun ? lastRun?.validation.errors.join("\n") : null) ||
          result?.steps.find((step) => step.error)?.error,
      } satisfies ValidationRow;
    })
    .filter(
      (row) =>
        row.file.path.toLowerCase().includes(search.toLowerCase()) &&
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
    return validationFileHref(
      row.file.path,
      suite.files.filter((file) => file.path === row.file.path).length > 1
        ? row.id
        : undefined,
    );
  }
  useEffect(() => {
    suite.setListHref(`${pathname}${queryString ? `?${queryString}` : ""}`);
  }, [pathname, queryString, suite.setListHref]);

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
      id: "filename",
      header: "Filename",
      cell: ({ row }) => {
        const { file, id, error } = row.original;
        return (
          <div className="max-w-xs">
            <RowClickShield>
              <Link
                className="block truncate font-mono text-sm"
                href={validationFileHref(
                  file.path,
                  suite.files.filter(
                    (candidate) => candidate.path === file.path,
                  ).length > 1
                    ? id
                    : undefined,
                )}
                title={file.path}
              >
                {file.path}
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
        <span className="whitespace-nowrap text-sm">
          {row.original.lastRunAt
            ? formatDate({ date: row.original.lastRunAt })
            : "Never"}
        </span>
      ),
    },
    {
      id: "assertions",
      header: "Assertions",
      cell: ({ row }) =>
        suite.summaries?.find((item) => item.path === row.original.file.path)
          ?.assertionCount ?? "—",
    },
    {
      id: "tools",
      header: "Tools exercised",
      cell: ({ row }) => {
        const summary = suite.summaries?.find(
          (item) => item.path === row.original.file.path,
        );
        return summary ? (
          summary.error ? (
            <span
              className="text-xs text-muted-foreground"
              title={summary.error}
            >
              Unparseable
            </span>
          ) : (
            <ToolsSummary tools={summary.tools} path={row.original.file.path} />
          )
        ) : (
          <span className="text-xs text-muted-foreground">
            {suite.collection.error ||
            suite.loadError ||
            !suite.validPaths ||
            suite.files.length > 32 ||
            suite.sourceChanged ||
            suite.inspectionError
              ? "Unavailable"
              : "Parsing…"}
          </span>
        );
      },
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
                placeholder="Search validation filenames…"
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
          tableClassName="min-w-[700px]"
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
          emptyDescription="Add a local file or select a Git directory containing .appa files."
        />
      </BulkActionsScope>
      <DeleteConfirmDialog
        open={deleteIds.length > 0}
        onOpenChange={(open) => {
          if (!open) setDeleteIds([]);
        }}
        title={`Delete ${deleteIds.length} validation ${deleteIds.length === 1 ? "file" : "files"}?`}
        description="These validation files will be deleted. Other unsaved edits will be kept."
        isPending={suite.busy}
        confirmDisabled={!canDelete}
        onConfirm={() => {
          suite.deleteFiles(deleteIds, () => setDeleteIds([]));
        }}
      />
    </div>
  );
}

function ToolsSummary({ tools, path }: { tools: string[]; path: string }) {
  if (!tools.length)
    return <span className="text-xs text-muted-foreground">No tools</span>;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {tools.slice(0, 2).map((tool) => (
        <span
          key={tool}
          className="max-w-48 truncate font-mono text-xs"
          title={tool}
        >
          {tool}
        </span>
      ))}
      {tools.length > 2 && (
        <RowClickShield>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`Show all tools for ${path}`}
              >
                <span>{`+${tools.length - 2}`}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="max-h-80 overflow-y-auto">
              <p className="mb-2 text-sm font-medium">Tools exercised</p>
              <ul className="space-y-1">
                {tools.map((tool) => (
                  <li key={tool} className="break-all font-mono text-xs">
                    {tool}
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        </RowClickShield>
      )}
    </div>
  );
}
