"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { DEFAULT_FILTER_ALL } from "@/consts";
import {
  type CoverageTool,
  useCoverageTools,
} from "@/lib/openappa-coverage.query";
import { GovernedByPill } from "./coverage-badges";

type ToolTableProps = {
  catalogId?: string;
  entityId?: string;
  autoMode?: boolean;
};

const FIRST_PAGE = { pageIndex: 0, pageSize: 10 };

/** Tools reachable through an entity, with the policy source for each rule. */
export function ToolTable({
  catalogId,
  entityId,
  autoMode = false,
}: ToolTableProps) {
  const [search, setSearch] = useState("");
  const [serverId, setServerId] = useState<string | undefined>();
  const [pagination, setPagination] = useState(FIRST_PAGE);
  const updateSearch = (value: string) => {
    setSearch(value);
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  };
  const updateServer = (value: string) => {
    setServerId(value === DEFAULT_FILTER_ALL ? undefined : value);
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  };
  const clearFilters = () => {
    setSearch("");
    setServerId(undefined);
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  };
  const tools = useCoverageTools({
    catalogId: catalogId ?? serverId,
    entityId,
    search: search || undefined,
    limit: pagination.pageSize,
    offset: pagination.pageIndex * pagination.pageSize,
  });
  const columns = useMemo<ColumnDef<CoverageTool>[]>(
    () => [
      {
        id: "server",
        header: "MCP server",
        size: 190,
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <McpCatalogIcon
              icon={row.original.catalogIcon}
              catalogId={row.original.catalogId}
              size={18}
            />
            <span>{row.original.catalogName || row.original.prefix}</span>
          </div>
        ),
      },
      {
        id: "tool",
        header: "Tool name",
        size: 230,
        cell: ({ row }) => <ToolNameCell tool={row.original} />,
      },
      {
        id: "policy",
        header: "Policy source",
        size: 240,
        cell: ({ row }) => <PolicySourceCell tool={row.original} />,
      },
    ],
    [],
  );

  if (tools.isLoadingError)
    return (
      <QueryLoadError
        title="Could not load the tools"
        onRetry={() => tools.refetch()}
        className="rounded-md border py-10"
      />
    );

  return (
    <div>
      <CollectionFilters>
        <FilterBar
          search={
            <SearchInput
              syncQueryParams={false}
              value={search}
              onSearchChange={updateSearch}
              isLoading={tools.isFetching}
              placeholder="Search tools"
              className={filterSearchClass}
            />
          }
          onClearFilters={search || serverId ? clearFilters : undefined}
        >
          {!catalogId && (
            <FilterSelect
              value={serverId ?? DEFAULT_FILTER_ALL}
              onValueChange={updateServer}
              placeholder="MCP server"
              ariaLabel="MCP server"
              items={[
                { value: DEFAULT_FILTER_ALL, label: "All MCP servers" },
                ...(tools.data?.servers ?? []).map((server) => ({
                  value: server.id,
                  label: server.name,
                })),
              ]}
            />
          )}
        </FilterBar>
      </CollectionFilters>
      <DataTable
        columns={columns}
        data={tools.data?.data ?? []}
        getRowId={(tool) => `${tool.toolId}:${tool.rule?.selector ?? ""}`}
        manualPagination
        pagination={{
          ...pagination,
          total: tools.data?.pagination.total ?? 0,
        }}
        onPaginationChange={setPagination}
        isLoading={tools.isFetching}
        emptyIcon={Wrench}
        emptyMessage="No tools available"
        emptyDescription={
          autoMode
            ? "No tools are currently reachable by you through this entity."
            : "Tools appear here once they are assigned or synced."
        }
        hasActiveFilters={Boolean(search || serverId)}
        filteredEmptyMessage="No tool matches these filters."
        onClearFilters={clearFilters}
      />
    </div>
  );
}

function ToolNameCell({ tool }: { tool: CoverageTool }) {
  return (
    <div className="font-mono text-xs">
      <span>{tool.name}</span>
      {tool.rule?.selector && (
        <div className="text-muted-foreground">{`when ${tool.rule.selector}`}</div>
      )}
    </div>
  );
}

function PolicySourceCell({ tool }: { tool: CoverageTool }) {
  if (!tool.rule)
    return tool.policySource === "built_in" ? (
      <Badge variant="outline">Built-in fallback</Badge>
    ) : (
      <GovernedByPill governedBy={{ source: "catchall" }} />
    );

  return (
    <div className="space-y-1">
      {tool.rule.source === "root" ? (
        <GovernedByPill governedBy={{ source: "root" }} />
      ) : (
        <GovernedByPill
          governedBy={{
            source: "battery",
            name: tool.rule.battery ?? "",
            status: tool.rule.batteryStatus ?? "refused",
          }}
        />
      )}
      {!tool.enforced && (
        <div className="text-xs text-muted-foreground">Not enforced</div>
      )}
    </div>
  );
}
