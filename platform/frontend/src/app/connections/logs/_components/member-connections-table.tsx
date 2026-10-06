"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";
import { ClientIcon } from "@/app/connection/client-icon";
import { CONNECT_CLIENTS } from "@/app/connection/clients";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { DataTable } from "@/components/ui/data-table";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import {
  type MemberConnectionStatus,
  type MemberConnections,
  useMemberConnections,
} from "@/lib/connected-client.query";
import { formatDate, formatRelativeTimeFromNow } from "@/lib/utils/date-time";

const ALL_VALUE = "all";

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: ALL_VALUE, label: "All members" },
  { value: "connected", label: "Connected" },
  { value: "not_connected", label: "Not connected" },
];

const CLIENTS_BY_ID = new Map(CONNECT_CLIENTS.map((c) => [c.id, c]));

function parseStatus(value: string | null): MemberConnectionStatus | undefined {
  return value === "connected" || value === "not_connected" ? value : undefined;
}

/**
 * Every member of the organization with the agents they connected through the
 * Connect page, so admins can see who has and who hasn't.
 */
export function MemberConnectionsTable() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const pageIndex = Math.max(0, Number(searchParams.get("page") ?? 1) - 1);
  const pageSize = Number(searchParams.get("limit") ?? DEFAULT_TABLE_LIMIT);
  const nameFilter = searchParams.get("name") ?? "";
  const status = parseStatus(searchParams.get("status"));

  const { data, isPending, isFetching, isLoadingError, refetch } =
    useMemberConnections({
      limit: pageSize,
      offset: pageIndex * pageSize,
      name: nameFilter || undefined,
      status,
    });

  const pushParams = useCallback(
    (update: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(searchParams.toString());
      update(params);
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const handlePaginationChange = useCallback(
    (next: { pageIndex: number; pageSize: number }) =>
      pushParams((params) => {
        params.set("page", String(next.pageIndex + 1));
        if (next.pageSize !== DEFAULT_TABLE_LIMIT) {
          params.set("limit", String(next.pageSize));
        } else {
          params.delete("limit");
        }
      }),
    [pushParams],
  );

  const handleStatusChange = useCallback(
    (value: string) =>
      pushParams((params) => {
        if (value === ALL_VALUE) params.delete("status");
        else params.set("status", value);
        params.set("page", "1");
      }),
    [pushParams],
  );

  const clearFilters = useCallback(
    () =>
      pushParams((params) => {
        params.delete("name");
        params.delete("status");
        params.set("page", "1");
      }),
    [pushParams],
  );

  if (isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load agent connections"
        onRetry={() => refetch()}
      />
    );
  }

  const hasFilters = Boolean(nameFilter || status);
  const summary = data?.summary;

  return (
    <div>
      <CollectionFilters>
        <FilterBar
          search={
            <SearchInput
              isLoading={isFetching}
              objectNamePlural="members"
              searchFields={["name", "email"]}
              paramName="name"
              className={filterSearchClass}
            />
          }
          onClearFilters={hasFilters ? clearFilters : undefined}
        >
          <FilterSelect
            value={status ?? ALL_VALUE}
            onValueChange={handleStatusChange}
            placeholder="Filter by status"
            items={STATUS_OPTIONS}
            inactiveValue={ALL_VALUE}
          />
        </FilterBar>
        {summary && (
          <p className="text-sm text-muted-foreground">
            {summary.connectedCount} of {summary.memberCount}{" "}
            {summary.memberCount === 1 ? "member has" : "members have"}{" "}
            connected an agent.
          </p>
        )}
      </CollectionFilters>
      <DataTable
        columns={columns}
        data={data?.data ?? []}
        getRowId={(row) => row.userId}
        manualPagination
        pagination={{
          pageIndex,
          pageSize,
          total: data?.pagination.total ?? 0,
        }}
        onPaginationChange={handlePaginationChange}
        isLoading={isPending || isFetching}
        hasActiveFilters={hasFilters}
        onClearFilters={clearFilters}
      />
    </div>
  );
}

const columns: ColumnDef<MemberConnections>[] = [
  {
    id: "member",
    header: "Member",
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="truncate font-medium">
          {row.original.name || row.original.email}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {row.original.email}
        </div>
      </div>
    ),
  },
  {
    id: "agents",
    header: "Agents",
    cell: ({ row }) =>
      row.original.clients.length === 0 ? (
        <span className="text-sm text-muted-foreground">Not connected</span>
      ) : (
        <ul className="space-y-1">
          {row.original.clients.map((client) => (
            <AgentLine key={client.clientId} client={client} />
          ))}
        </ul>
      ),
  },
  {
    id: "firstConnected",
    header: "First connected",
    cell: ({ row }) => {
      const first = earliest(row.original.clients);
      return first ? (
        <span className="text-sm" title={formatDate({ date: first })}>
          {formatDate({ date: first, dateFormat: "MMM d, yyyy" })}
        </span>
      ) : (
        <span className="text-sm text-muted-foreground">—</span>
      );
    },
  },
  {
    id: "lastConnected",
    header: "Last connected",
    cell: ({ row }) => {
      const last = row.original.lastConnectedAt;
      return last ? (
        <span className="text-sm" title={formatDate({ date: last })}>
          {formatRelativeTimeFromNow(last)}
        </span>
      ) : (
        <span className="text-sm text-muted-foreground">Never</span>
      );
    },
  },
];

function AgentLine({
  client,
}: {
  client: MemberConnections["clients"][number];
}) {
  const known = CLIENTS_BY_ID.get(client.clientId);
  const label = known?.label ?? client.clientId;
  return (
    <li className="flex min-w-0 items-center gap-2 text-sm">
      {known && <ClientIcon client={known} size={18} />}
      <span className="shrink-0">{label}</span>
      {client.deviceNames.length > 0 && (
        <span
          className="truncate text-xs text-muted-foreground"
          title={client.deviceNames.join(", ")}
        >
          {client.deviceNames.join(", ")}
        </span>
      )}
    </li>
  );
}

function earliest(clients: MemberConnections["clients"]): string | null {
  return clients.reduce<string | null>(
    (first, client) =>
      first === null || client.connectedAt < first ? client.connectedAt : first,
    null,
  );
}
