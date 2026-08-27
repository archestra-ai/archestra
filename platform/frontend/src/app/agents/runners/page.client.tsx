"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Box, Container, Pencil, Plus, Trash2 } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  FilterBar,
  FilterSelect,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import { LabelKeyRowBase, LabelSelect } from "@/components/label-select";
import { LabelTags } from "@/components/label-tags";
import { PageLayout } from "@/components/page-layout";
import { SearchInput } from "@/components/search-input";
import {
  TableCard,
  TableCardList,
  TableCardView,
  TableCardViewContent,
  TableCardViewToggle,
} from "@/components/table-card-view";
import { Badge } from "@/components/ui/badge";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import { useEnvironments } from "@/lib/environment.query";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import {
  type Runner,
  useBulkDeleteRunners,
  useRunnerLabelKeys,
  useRunnerLabelValues,
  useRunners,
} from "@/lib/runners.query";
import { RunnerDialog } from "./_parts/runner-dialog";

const PAGE_SIZE = 20;
const ALL_ENVIRONMENTS = "all";

export default function RunnersPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const search = searchParams.get("search") ?? "";
  const labels = searchParams.get("labels") ?? "";
  const environmentId = searchParams.get("environmentId") ?? ALL_ENVIRONMENTS;
  const [pageIndex, setPageIndex] = useState(0);

  const [editing, setEditing] = useState<Runner | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const filters = useMemo(
    () => ({
      search: search || undefined,
      labels: labels || undefined,
      environmentId:
        environmentId === ALL_ENVIRONMENTS ? undefined : environmentId,
      limit: PAGE_SIZE,
      offset: pageIndex * PAGE_SIZE,
    }),
    [search, labels, environmentId, pageIndex],
  );

  const { data, isPending } = useRunners(filters);
  const runners = useMemo(() => data?.runners ?? [], [data]);
  const total = data?.total ?? 0;

  const { data: environmentList } = useEnvironments();
  const { data: labelKeys } = useRunnerLabelKeys();
  const bulkDelete = useBulkDeleteRunners();

  const hasActiveFilters =
    Boolean(search) || Boolean(labels) || environmentId !== ALL_ENVIRONMENTS;

  const filterSignature = JSON.stringify(filters);
  const {
    rowSelection,
    setRowSelection,
    onPageRowIdsChange,
    clearSelection,
    selected,
    selectAllMatching,
  } = useBulkSelection({
    rows: runners,
    getId: (runner) => runner.id,
    filterSignature,
    matchDescription: search ? "match this search query" : "match the filters",
  });

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams.toString());
      if (value === null || value === "") {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      setPageIndex(0);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const clearFilters = useCallback(() => {
    router.replace(pathname, { scroll: false });
    setPageIndex(0);
  }, [pathname, router]);

  const openCreate = useCallback(() => {
    setEditing(null);
    setDialogOpen(true);
  }, []);
  const openEdit = useCallback((runner: Runner) => {
    setEditing(runner);
    setDialogOpen(true);
  }, []);

  const environmentName = useCallback(
    (id: string | null) => {
      if (!id) return "Default";
      return (
        environmentList?.environments.find((env) => env.id === id)?.name ??
        "Unknown"
      );
    },
    [environmentList],
  );

  const columns = useMemo<ColumnDef<Runner>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        size: 240,
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="truncate font-medium">{row.original.name}</div>
            {row.original.description ? (
              <div className="truncate text-xs text-muted-foreground">
                {row.original.description}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        accessorKey: "image",
        header: "Image",
        size: 240,
        // `truncate` needs a block box with a width to clip against — on a bare
        // inline <code> the text escapes and paints over the next column.
        cell: ({ row }) => (
          <div className="min-w-0">
            <code className="block truncate text-xs text-muted-foreground">
              {row.original.image}
            </code>
          </div>
        ),
      },
      {
        id: "credentials",
        header: "Credentials",
        size: 170,
        cell: ({ row }) => {
          const declared = row.original.credentials ?? [];
          if (declared.length === 0) {
            return <span className="text-xs text-muted-foreground">None</span>;
          }
          const perUser = declared.filter(
            (entry) => entry.scope === "per_user",
          ).length;
          return (
            <span className="text-xs text-muted-foreground">
              {declared.length} declared
              {perUser > 0 ? ` · ${perUser} per-user` : ""}
            </span>
          );
        },
      },
      {
        id: "environment",
        header: "Environment",
        size: 120,
        cell: ({ row }) => (
          <Badge variant="outline">
            {environmentName(row.original.environmentId)}
          </Badge>
        ),
      },
      {
        id: "labels",
        header: "Labels",
        size: 80,
        cell: ({ row }) => <LabelTags labels={row.original.labels} />,
      },
      {
        id: "actions",
        header: "",
        size: 60,
        cell: ({ row }) => (
          <PermissionButton
            permissions={{ runner: ["update"] }}
            variant="ghost"
            size="sm"
            onClick={() => openEdit(row.original)}
          >
            <Pencil className="h-4 w-4" />
          </PermissionButton>
        ),
      },
    ],
    [environmentName, openEdit],
  );

  return (
    <PageLayout
      title="Runners"
      description={
        <p className="text-sm text-muted-foreground">
          A runner is the container an agent&apos;s long-running work executes
          in — an image, the credentials it needs, and the environment whose
          egress rules it inherits. Assign one to an agent to give it a place to
          run.
        </p>
      }
      actionButton={
        <PermissionButton
          permissions={{ runner: ["create"] }}
          onClick={openCreate}
        >
          <Plus className="h-4 w-4" />
          Create Runner
        </PermissionButton>
      }
    >
      <TableCardView storageKey="archestra-runners-view">
        <div className="mb-3 flex flex-col gap-2">
          <FilterBar actions={<TableCardViewToggle />}>
            <SearchInput
              objectNamePlural="runners"
              searchFields={["name", "description"]}
              paramName="search"
              className={filterSearchClass}
            />
            <FilterSelect
              value={environmentId}
              onValueChange={(value) =>
                setParam(
                  "environmentId",
                  value === ALL_ENVIRONMENTS ? null : value,
                )
              }
              placeholder="Environment"
              inactiveValue={ALL_ENVIRONMENTS}
              items={[
                { value: ALL_ENVIRONMENTS, label: "All environments" },
                ...(environmentList?.environments ?? []).map((env) => ({
                  value: env.id,
                  label: env.name,
                })),
              ]}
            />
            <LabelSelect
              labelKeys={labelKeys}
              LabelKeyRowComponent={RunnerLabelKeyRow}
              className={filterControlClass({ active: Boolean(labels) })}
            />
          </FilterBar>
        </div>

        <BulkActions
          count={selected.length}
          noun="runner"
          onClear={clearSelection}
          busy={bulkDelete.isPending}
          selectAllMatching={{ ...selectAllMatching, total }}
        >
          <PermissionButton
            permissions={{ runner: ["delete"] }}
            variant="destructive"
            size="sm"
            onClick={() => setBulkDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            <span>Delete</span>
          </PermissionButton>
        </BulkActions>

        <TableCardViewContent
          cards={
            <TableCardList
              itemCount={runners.length}
              isLoading={isPending}
              emptyIcon={Container}
              emptyMessage="No runners yet"
              emptyDescription="Create a runner to give an agent a container to do long-running work in."
              hasActiveFilters={hasActiveFilters}
              filteredEmptyMessage="No runners match your filters"
              onClearFilters={clearFilters}
              pagination={{ pageIndex, pageSize: PAGE_SIZE, total }}
              onPaginationChange={({ pageIndex: next }) => setPageIndex(next)}
            >
              {runners.map((runner) => (
                <TableCard
                  key={runner.id}
                  title={runner.name}
                  description={runner.description ?? runner.image}
                  icon={<Box className="h-4 w-4" />}
                  selected={Boolean(rowSelection[runner.id])}
                  onSelectedChange={(value) =>
                    setRowSelection({ ...rowSelection, [runner.id]: value })
                  }
                  selectionLabel={`Select ${runner.name}`}
                  actions={
                    <PermissionButton
                      permissions={{ runner: ["update"] }}
                      variant="ghost"
                      size="sm"
                      onClick={() => openEdit(runner)}
                    >
                      <Pencil className="h-4 w-4" />
                    </PermissionButton>
                  }
                  footer={
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">
                        {environmentName(runner.environmentId)}
                      </Badge>
                      <LabelTags labels={runner.labels} />
                    </div>
                  }
                >
                  <code className="block truncate text-xs text-muted-foreground">
                    {runner.image}
                  </code>
                </TableCard>
              ))}
            </TableCardList>
          }
          table={
            <DataTable
              columns={columns}
              data={runners}
              getRowId={(runner) => runner.id}
              rowSelection={rowSelection}
              onRowSelectionChange={setRowSelection}
              onPageRowIdsChange={onPageRowIdsChange}
              manualPagination
              pagination={{ pageIndex, pageSize: PAGE_SIZE, total }}
              onPaginationChange={({ pageIndex: next }) => setPageIndex(next)}
              isLoading={isPending}
              emptyIcon={Container}
              emptyMessage="No runners yet"
              emptyDescription="Create a runner to give an agent a container to do long-running work in."
              hasActiveFilters={hasActiveFilters}
              filteredEmptyMessage="No runners match your filters"
              onClearFilters={clearFilters}
            />
          }
        />
      </TableCardView>

      <RunnerDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        runner={editing}
      />

      <DeleteConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title={`Delete ${selected.length} runner${selected.length === 1 ? "" : "s"}?`}
        description="Agents assigned to a deleted runner lose their long-running mode until you assign another."
        isPending={bulkDelete.isPending}
        onConfirm={async () => {
          await bulkDelete.mutateAsync(selected.map((runner) => runner.id));
          clearSelection();
          setBulkDeleteOpen(false);
        }}
      />
    </PageLayout>
  );
}

/** Values load only once its key's row is opened. */
function RunnerLabelKeyRow({
  labelKey,
  selectedValues,
  onToggleValue,
}: {
  labelKey: string;
  selectedValues: string[];
  onToggleValue: (key: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: values } = useRunnerLabelValues({
    key: open ? labelKey : undefined,
  });
  return (
    <LabelKeyRowBase
      labelKey={labelKey}
      selectedValues={selectedValues}
      onToggleValue={onToggleValue}
      values={values}
      onOpenChange={setOpen}
    />
  );
}
