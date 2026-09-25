"use client";

import type { Column, ColumnDef, SortingState } from "@tanstack/react-table";
import { Bot, ChevronDown, ChevronUp, MessageCircle } from "lucide-react";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { AgentIcon } from "@/components/agent-icon";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import { DEFAULT_FILTER_ALL } from "@/consts";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useQueryParamsAdapter } from "@/lib/hooks/use-query-params-adapter";
import {
  type CoverageEntity,
  useCoverageEntities,
} from "@/lib/openappa-coverage.query";
import { openAppaChatHref } from "@/lib/openappa-routes";
import { RuleCoverageBar } from "./rule-coverage-bar";
import { ToolTable } from "./tool-table";

const PARAM_NAMES = {
  page: "entitiesPage",
  pageSize: "entitiesPageSize",
  search: "entitiesSearch",
  type: "entitiesType",
  sortBy: "entitiesSortBy",
  sortDirection: "entitiesSortDirection",
} as const;

/** The columns the table sorts by, named as the API sorts. */
const SORTABLE = ["name", "type", "tools"] as const;
type SortColumn = (typeof SORTABLE)[number];
/** MCP servers first, then gateways, each by name. */
const DEFAULT_SORT: { id: SortColumn; desc: boolean } = {
  id: "type",
  desc: false,
};

const TYPE_OPTIONS = [
  { value: DEFAULT_FILTER_ALL, label: "All types" },
  { value: "mcp_gateway", label: "MCP gateway" },
  { value: "mcp_server", label: "MCP server" },
] as const;

/**
 * Every MCP server and MCP gateway, sortable by name, type and tool count, each
 * with a chat that reviews its rules.
 */
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
  const rawType = searchParams.get("type");
  const type =
    rawType === "mcp_gateway" || rawType === "mcp_server" ? rawType : undefined;
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
    type,
    sortBy: sort.id,
    sortDirection: sort.desc ? "desc" : "asc",
    limit,
    offset: pageIndex * limit,
  });
  const hasActiveFilters = !!search || !!type;
  const clearFilters = useCallback(
    () => updateQueryParams({ search: null, type: null, page: "1" }),
    [updateQueryParams],
  );

  const columns = useMemo<ColumnDef<CoverageEntity>[]>(
    () => [
      {
        id: "name",
        accessorFn: (row) => row.name,
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        size: 260,
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
        id: "type",
        accessorFn: (row) => row.type,
        header: ({ column }) => <SortHeader column={column} label="Type" />,
        size: 210,
        cell: ({ row }) => (
          <span className="flex items-center gap-2">
            <span>{entityTypeLabel(row.original.type)}</span>
            {row.original.autoMode && (
              <Badge variant="outline" className="font-normal">
                Auto mode
              </Badge>
            )}
          </span>
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
            {/* Capped, so a wide screen leaves room after it, not a longer bar. */}
            <RuleCoverageBar
              counts={row.original.rules}
              total={row.original.toolCount}
              className="h-1.5 min-w-0 max-w-48 flex-1"
            />
            <span className="text-muted-foreground w-28 shrink-0 whitespace-nowrap text-right text-xs tabular-nums">
              {`${row.original.governedCount.toLocaleString()} of ${row.original.toolCount.toLocaleString()} covered`}
            </span>
          </div>
        ),
      },
      {
        id: "actions",
        header: "Actions",
        size: 100,
        cell: ({ row }) => (
          <PermissionButton
            permissions={
              row.original.type === "mcp_server"
                ? { mcpRegistry: ["read"] }
                : {}
            }
            variant="outline"
            size="sm"
            className="h-7"
            // On the button, so a refused one, which drops the link, keeps it.
            aria-label={`Ask in chat: ${row.original.name}`}
            asChild
          >
            <Link
              href={openAppaChatHref({
                promptKey: "reviewCoverage",
                target: { kind: row.original.type, id: row.original.id },
              })}
              onClick={(event) => event.stopPropagation()}
            >
              <MessageCircle />
              <span>Ask</span>
            </Link>
          </PermissionButton>
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
              placeholder="Search servers and gateways"
              isLoading={entities.isFetching}
              className={filterSearchClass}
            />
          }
          onClearFilters={hasActiveFilters ? clearFilters : undefined}
          actions={
            entities.data ? (
              <span className="text-sm text-muted-foreground tabular-nums">
                {`${entities.data.pagination.total} servers and gateways`}
              </span>
            ) : null
          }
        >
          <FilterSelect
            value={type ?? DEFAULT_FILTER_ALL}
            onValueChange={(value) =>
              updateQueryParams({
                type: value === DEFAULT_FILTER_ALL ? null : value,
                page: "1",
              })
            }
            placeholder="Type"
            ariaLabel="Type"
            showSearch={false}
            items={[...TYPE_OPTIONS]}
          />
        </FilterBar>
      </CollectionFilters>
      {entities.isLoadingError ? (
        <QueryLoadError
          title="Could not load servers and gateways"
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
          // Name and type keep their width; coverage takes what is left.
          fixedWidthColumnIds={["name", "type"]}
          flexibleColumnIds={["tools"]}
          tableClassName="min-w-3xl"
          manualSorting
          sorting={sorting}
          onSortingChange={setSorting}
          isLoading={entities.isFetching}
          emptyIcon={Bot}
          emptyMessage="No servers or gateways"
          emptyDescription="MCP gateways and MCP servers appear here when available."
          hasActiveFilters={hasActiveFilters}
          filteredEmptyMessage="No server or gateway matches these filters."
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
  return (
    <StandardDialog
      open={selected !== null}
      onOpenChange={(open) => !open && onClose()}
      size="large"
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
    >
      {selected && (
        <ToolTable
          key={selected.id}
          catalogId={selected.type === "mcp_server" ? selected.id : undefined}
          entityId={selected.type === "mcp_server" ? undefined : selected.id}
          autoMode={selected.autoMode}
        />
      )}
    </StandardDialog>
  );
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
    { value: entity.governedCount, label: "with a rule" },
    { value: entity.fallbackCount, label: "with no rule" },
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
    <span className="flex flex-col gap-3">
      <span>{entityTypeLabel(entity.type)}</span>
      <span className="flex flex-wrap gap-x-6 gap-y-2">
        {stats.map((stat) => (
          <span key={stat.label} className="flex items-baseline gap-1.5">
            <span className="font-medium text-foreground tabular-nums">
              {stat.value}
            </span>
            <span>{stat.label}</span>
          </span>
        ))}
      </span>
    </span>
  );
}
