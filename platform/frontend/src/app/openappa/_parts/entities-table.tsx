"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Bot, ChevronRight } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { AgentIcon } from "@/components/agent-icon";
import { AgentNameCell } from "@/components/agent-name-cell";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { QueryLoadError } from "@/components/query-load-error";
import { ScopeBadge } from "@/components/scope-badge";
import { scopeLabel } from "@/components/scope-vocabulary";
import { SearchInput } from "@/components/search-input";
import { StandardDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DEFAULT_FILTER_ALL } from "@/consts";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useQueryParamsAdapter } from "@/lib/hooks/use-query-params-adapter";
import {
  type CoverageEntity,
  useCoverageEntities,
} from "@/lib/openappa-coverage.query";
import { ToolTable } from "./tool-table";

const PARAM_NAMES = {
  page: "entitiesPage",
  pageSize: "entitiesPageSize",
  search: "entitiesSearch",
  type: "entitiesType",
} as const;

const TYPE_OPTIONS = [
  { value: DEFAULT_FILTER_ALL, label: "All types" },
  { value: "agent", label: "Agent" },
  { value: "mcp_gateway", label: "MCP gateway" },
  { value: "mcp_server", label: "MCP server" },
] as const;

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
    rawType === "agent" || rawType === "mcp_gateway" || rawType === "mcp_server"
      ? rawType
      : undefined;
  const entities = useCoverageEntities({
    search,
    type,
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
        header: "Name",
        size: 320,
        cell: ({ row }) => (
          <AgentNameCell
            name={row.original.name}
            icon={
              row.original.type === "mcp_server" ? (
                <McpCatalogIcon
                  icon={row.original.icon}
                  catalogId={row.original.id}
                  size={20}
                />
              ) : (
                <AgentIcon
                  icon={row.original.icon}
                  fallbackType={row.original.type}
                  size={20}
                />
              )
            }
          />
        ),
      },
      {
        id: "type",
        header: "Type",
        size: 150,
        cell: ({ row }) => entityTypeLabel(row.original.type),
      },
      {
        id: "visibility",
        header: "Visibility",
        size: 150,
        cell: ({ row }) => <ScopeBadge scope={row.original.scope} showLabel />,
      },
      {
        id: "tools",
        header: "Tools",
        size: 190,
        cell: ({ row }) => (
          <div>
            <span className="tabular-nums">
              {`${row.original.governedCount} of ${row.original.toolCount} with tool rules`}
            </span>
            {row.original.autoMode && (
              <span className="block text-xs text-muted-foreground">
                Includes your Auto mode access
              </span>
            )}
          </div>
        ),
      },
      {
        id: "actions",
        header: "Actions",
        size: 110,
        cell: ({ row }) => (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Details for ${row.original.name}`}
            onClick={(event) => {
              event.stopPropagation();
              setSelected(row.original);
            }}
          >
            <span>Details</span>
            <ChevronRight className="size-3.5" />
          </Button>
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
              placeholder="Search policy targets"
              isLoading={entities.isFetching}
              className={filterSearchClass}
            />
          }
          onClearFilters={hasActiveFilters ? clearFilters : undefined}
          actions={
            entities.data ? (
              <span className="text-sm text-muted-foreground tabular-nums">
                {`${entities.data.pagination.total} policy targets`}
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
          title="Could not load policy targets"
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
          isLoading={entities.isFetching}
          emptyIcon={Bot}
          emptyMessage="No policy targets"
          emptyDescription="Agents, MCP gateways, and MCP servers appear here when available."
          hasActiveFilters={hasActiveFilters}
          filteredEmptyMessage="No policy target matches these filters."
          onClearFilters={clearFilters}
        />
      )}
      <StandardDialog
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
        size="large"
        title={selected?.name ?? "Policy target"}
        description={selected ? entityDescription(selected) : undefined}
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
    </>
  );
}

export function entityTypeLabel(type: CoverageEntity["type"]): string {
  switch (type) {
    case "agent":
      return "Agent";
    case "mcp_gateway":
      return "MCP gateway";
    case "mcp_server":
      return "MCP server";
  }
}

function entityDescription(entity: CoverageEntity): string {
  const toolCount =
    entity.type === "mcp_server"
      ? `${entity.toolCount} synced tools`
      : entity.autoMode
        ? `${entity.toolCount} tools reachable for you`
        : `${entity.toolCount} assigned tools`;
  return [
    entityTypeLabel(entity.type),
    scopeLabel(entity.scope),
    toolCount,
    `${entity.governedCount} with active explicit rules`,
    `${entity.fallbackCount} may use the catch-all`,
    entity.builtInCount > 0
      ? `${entity.builtInCount} built-in ${entity.builtInCount === 1 ? "tool" : "tools"}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
