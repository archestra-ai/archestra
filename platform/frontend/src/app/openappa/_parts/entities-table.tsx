"use client";

import type { Column, ColumnDef, SortingState } from "@tanstack/react-table";
import { Bot, ChevronDown, ChevronUp, TriangleAlert, X } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { AgentIcon } from "@/components/agent-icon";
import {
  CollectionFilters,
  FilterBar,
  filterSearchClass,
} from "@/components/filter-bar";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DialogClose } from "@/components/ui/dialog";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useQueryParamsAdapter } from "@/lib/hooks/use-query-params-adapter";
import {
  type CoverageEntity,
  useCoverageEntities,
} from "@/lib/openappa-coverage.query";
import { cn } from "@/lib/utils/tailwind";
import { RuleCoverageBar } from "./rule-coverage-bar";
import { TargetChatActions } from "./target-chat-actions";
import { ToolTable } from "./tool-table";

const PARAM_NAMES = {
  page: "entitiesPage",
  pageSize: "entitiesPageSize",
  search: "entitiesSearch",
  sortBy: "entitiesSortBy",
  sortDirection: "entitiesSortDirection",
} as const;

/** The columns the table sorts by, named as the API sorts. */
const SORTABLE = ["name", "tools"] as const;
type SortColumn = (typeof SORTABLE)[number];
/** MCP servers by name. */
const DEFAULT_SORT: { id: SortColumn; desc: boolean } = {
  id: "name",
  desc: false,
};

/** Every visible MCP server, with a chat that reviews its rules. */
export function EntitiesTable() {
  const [selected, setSelected] = useState<CoverageEntity | null>(null);
  const queryParamsAdapter = useQueryParamsAdapter({ paramNames: PARAM_NAMES });
  const {
    searchParams,
    pageIndex,
    pageSize,
    updateQueryParams,
    setPagination,
  } = useDataTableQueryParams({ queryParamsAdapter });
  const limit = Math.min(pageSize, 100);
  const search = searchParams.get("search") || undefined;
  const rawSortBy = searchParams.get("sortBy");
  const sort = SORTABLE.some((column) => column === rawSortBy)
    ? {
        id: rawSortBy as SortColumn,
        desc: searchParams.get("sortDirection") === "desc",
      }
    : DEFAULT_SORT;
  const sorting = useMemo<SortingState>(
    () => [{ id: sort.id, desc: sort.desc }],
    [sort.id, sort.desc],
  );
  const setSorting = useCallback(
    (next: SortingState) => {
      // No sort goes back to the default.
      const [column] = next;
      updateQueryParams({
        sortBy: column?.id ?? null,
        sortDirection: column ? (column.desc ? "desc" : "asc") : null,
        page: "1",
      });
    },
    [updateQueryParams],
  );
  const entities = useCoverageEntities({
    search,
    type: "mcp_server",
    sortBy: sort.id,
    sortDirection: sort.desc ? "desc" : "asc",
    limit,
    offset: pageIndex * limit,
  });
  const hasActiveFilters = !!search;
  const clearFilters = useCallback(
    () => updateQueryParams({ search: null, page: "1" }),
    [updateQueryParams],
  );

  const columns = useMemo<ColumnDef<CoverageEntity>[]>(
    () => [
      {
        id: "name",
        accessorFn: (row) => row.name,
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        size: 300,
        cell: ({ row }) => (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-1.5 h-7 max-w-full justify-start gap-2 px-1.5"
            onClick={() => setSelected(row.original)}
          >
            <EntityIcon entity={row.original} size={16} />
            <span className="truncate" title={row.original.name}>
              {row.original.name}
            </span>
          </Button>
        ),
      },
      {
        id: "tools",
        accessorFn: (row) => row.toolCount,
        header: ({ column }) => (
          <SortHeader column={column} label="Tool coverage" />
        ),
        cell: ({ row }) => (
          <div className="flex items-center gap-3">
            <RuleCoverageBar
              counts={row.original.rules}
              total={row.original.toolCount}
              className="h-1.5 min-w-20 flex-1"
            />
            <CoverageCount
              covered={
                row.original.rules.root +
                row.original.rules.battery +
                row.original.rules.catchAll
              }
              total={row.original.toolCount}
            />
          </div>
        ),
      },
      {
        id: "actions",
        // Buttons label themselves, so the title is for screen readers. Cells pad
        // less on the right; the cell's pr-2 evens that edge with the left.
        header: () => <span className="sr-only">Actions</span>,
        size: 216,
        cell: ({ row }) => (
          <div className="pr-2">
            <TargetChatActions size="xs" target={targetOf(row.original)} />
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <>
      <CollectionFilters>
        <FilterBar
          search={
            <SearchInput
              queryParamsAdapter={queryParamsAdapter}
              placeholder="Search MCP servers"
              isLoading={entities.isFetching}
              className={filterSearchClass}
            />
          }
          onClearFilters={hasActiveFilters ? clearFilters : undefined}
          actions={
            entities.data ? (
              <span className="text-sm text-muted-foreground tabular-nums">
                {`${entities.data.pagination.total} MCP servers`}
              </span>
            ) : null
          }
        />
      </CollectionFilters>
      {entities.isLoadingError ? (
        <QueryLoadError
          title="Could not load MCP servers"
          onRetry={() => entities.refetch()}
          className="rounded-md border py-10"
        />
      ) : (
        <DataTable
          columns={columns}
          data={entities.data?.data ?? []}
          getRowId={(row) => `${row.type}:${row.id}`}
          onRowClick={(row) => setSelected(row)}
          manualPagination
          pagination={{
            pageIndex,
            pageSize: limit,
            total: entities.data?.pagination.total ?? 0,
          }}
          onPaginationChange={setPagination}
          // Name and actions keep their width; coverage takes what is left.
          fixedWidthColumnIds={["name", "actions"]}
          flexibleColumnIds={["tools"]}
          tableClassName="min-w-3xl"
          manualSorting
          sorting={sorting}
          onSortingChange={setSorting}
          isLoading={entities.isFetching}
          emptyIcon={Bot}
          emptyMessage="No MCP servers"
          emptyDescription="MCP servers appear here when available."
          hasActiveFilters={hasActiveFilters}
          filteredEmptyMessage="No MCP server matches these filters."
          onClearFilters={clearFilters}
        />
      )}
      <PolicyTargetDialog target={selected} onClose={() => setSelected(null)} />
    </>
  );
}

/** A column header that sorts the table, ascending first. */
function SortHeader({
  column,
  label,
}: {
  column: Column<CoverageEntity>;
  label: string;
}) {
  const sorted = column.getIsSorted();
  return (
    <Button
      variant="ghost"
      className="-ml-1.5 h-7 gap-1 px-1.5 font-medium"
      onClick={() => column.toggleSorting(sorted === "asc")}
    >
      <span>{label}</span>
      {sorted === "asc" ? (
        <ChevronUp className="size-3.5" />
      ) : sorted === "desc" ? (
        <ChevronDown className="size-3.5" />
      ) : (
        <span className="text-muted-foreground flex flex-col">
          <ChevronUp className="-mb-1 size-3" />
          <ChevronDown className="size-3" />
        </span>
      )}
    </Button>
  );
}

/** A policy target's tools and the rule that judges each, while `target` is set. */
function PolicyTargetDialog({
  target: selected,
  onClose,
}: {
  target: CoverageEntity | null;
  onClose: () => void;
}) {
  const toolsRef = useRef<HTMLDivElement>(null);
  return (
    <StandardDialog
      open={selected !== null}
      onOpenChange={(open) => !open && onClose()}
      size="large"
      // As tall as its rows, up to the large dialog's height.
      className="h-auto max-h-[90vh]"
      // The table's pagination already leaves a gap below it.
      bodyClassName="pb-0"
      headerClassName="pr-72"
      // Focus the tools, not the close button, so nothing opens ringed.
      initialFocusRef={toolsRef}
      title={
        selected ? (
          <span className="flex items-center gap-2.5">
            <EntityIcon entity={selected} size={24} />
            <span className="truncate">{selected.name}</span>
          </span>
        ) : (
          "Policy target"
        )
      }
      description={selected ? <EntitySummary entity={selected} /> : undefined}
      headerAction={
        selected ? (
          <div className="flex items-center gap-1">
            <TargetChatActions size="sm" target={targetOf(selected)} />
            <DialogClose asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X />
              </Button>
            </DialogClose>
          </div>
        ) : undefined
      }
    >
      {selected && (
        <div ref={toolsRef} tabIndex={-1} className="outline-none">
          <ToolTable
            key={selected.id}
            catalogId={selected.type === "mcp_server" ? selected.id : undefined}
            entityId={selected.type === "mcp_server" ? undefined : selected.id}
            autoMode={selected.autoMode}
            target={targetOf(selected)}
          />
        </div>
      )}
    </StandardDialog>
  );
}

function targetOf(entity: CoverageEntity) {
  return { kind: entity.type, id: entity.id, name: entity.name };
}

function entityTypeLabel(type: CoverageEntity["type"]): string {
  switch (type) {
    case "agent":
      return "Agent";
    case "mcp_gateway":
      return "MCP gateway";
    case "mcp_server":
      return "MCP server";
  }
}

function EntityIcon({
  entity,
  size,
}: {
  entity: CoverageEntity;
  size: number;
}) {
  return entity.type === "mcp_server" ? (
    <McpCatalogIcon icon={entity.icon} catalogId={entity.id} size={size} />
  ) : (
    <AgentIcon icon={entity.icon} fallbackType={entity.type} size={size} />
  );
}

// Rendered inside the dialog's description paragraph, so it sticks to inline
// elements.
function EntitySummary({ entity }: { entity: CoverageEntity }) {
  const toolLabel =
    entity.type === "mcp_server"
      ? "synced tools"
      : entity.autoMode
        ? "tools reachable for you"
        : "assigned tools";
  const stats = [
    { value: entity.toolCount, label: toolLabel },
    {
      value: entity.rules.root + entity.rules.battery + entity.rules.catchAll,
      label: "covered",
    },
    {
      value: entity.rules.notCovered,
      label: "no rule",
    },
    ...(entity.builtInCount > 0
      ? [
          {
            value: entity.builtInCount,
            label:
              entity.builtInCount === 1 ? "built-in tool" : "built-in tools",
          },
        ]
      : []),
  ];

  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5">
      <span>{entityTypeLabel(entity.type)}</span>
      {stats.map((stat) => (
        <span key={stat.label} className="flex items-baseline gap-1.5">
          <span aria-hidden>·</span>
          <span className="font-medium text-foreground tabular-nums">
            {stat.value}
          </span>
          <span>{stat.label}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * "N of M covered", turned to a warning when fewer than half of the tools
 * have a rule: those calls run with any data.
 */
function CoverageCount({ covered, total }: { covered: number; total: number }) {
  const low = total > 0 && covered * 2 < total;
  return (
    <span
      className={cn(
        "flex w-32 shrink-0 items-center gap-1.5 whitespace-nowrap text-xs tabular-nums",
        low ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
      )}
    >
      {low && <TriangleAlert aria-hidden className="size-3.5" />}
      <span>
        {`${covered.toLocaleString()} of ${total.toLocaleString()}${low ? (covered === 0 ? " · no rules" : " · low") : " covered"}`}
      </span>
    </span>
  );
}
