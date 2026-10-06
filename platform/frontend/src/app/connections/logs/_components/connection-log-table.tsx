"use client";

import {
  INSTALLER_CLIENT_IDS,
  INSTALLER_CLIENT_LABELS,
  isInstallerClientId,
} from "@archestra/shared/connection-setup";
import type { ColumnDef } from "@tanstack/react-table";
import { User } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import {
  type ConnectionLogEntry,
  useConnectionLog,
} from "@/lib/connected-client.query";
import { formatDate, formatRelativeTimeFromNow } from "@/lib/utils/date-time";

const ALL_VALUE = "all";

const AGENT_OPTIONS = [
  { value: ALL_VALUE, label: "All agents" },
  ...INSTALLER_CLIENT_IDS.map((id) => ({
    value: id,
    label: INSTALLER_CLIENT_LABELS[id],
  })),
];

const PLATFORM_LABEL: Record<ConnectionLogEntry["platform"], string> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};

const CLIENTS_BY_ID = new Map(CONNECT_CLIENTS.map((c) => [c.id, c]));

/** Each time a member connected an agent through the Connect page. */
export function ConnectionLogTable() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const pageIndex = Math.max(0, Number(searchParams.get("page") ?? 1) - 1);
  const pageSize = Number(searchParams.get("limit") ?? DEFAULT_TABLE_LIMIT);
  const search = searchParams.get("search") ?? "";
  const agentParam = searchParams.get("agent");
  const clientId =
    agentParam && isInstallerClientId(agentParam) ? agentParam : undefined;

  const { data, isPending, isFetching, isLoadingError, refetch } =
    useConnectionLog({
      limit: pageSize,
      offset: pageIndex * pageSize,
      search: search || undefined,
      clientId,
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

  const handleAgentChange = useCallback(
    (value: string) =>
      pushParams((params) => {
        if (value === ALL_VALUE) params.delete("agent");
        else params.set("agent", value);
        params.set("page", "1");
      }),
    [pushParams],
  );

  const clearFilters = useCallback(
    () =>
      pushParams((params) => {
        params.delete("search");
        params.delete("agent");
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

  const hasFilters = Boolean(search || clientId);

  return (
    <div>
      <CollectionFilters>
        <FilterBar
          search={
            <SearchInput
              isLoading={isFetching}
              objectNamePlural="connections"
              searchFields={["name", "email"]}
              paramName="search"
              className={filterSearchClass}
            />
          }
          onClearFilters={hasFilters ? clearFilters : undefined}
        >
          <FilterSelect
            value={clientId ?? ALL_VALUE}
            onValueChange={handleAgentChange}
            placeholder="Filter by agent"
            items={AGENT_OPTIONS}
            inactiveValue={ALL_VALUE}
          />
        </FilterBar>
      </CollectionFilters>
      <DataTable
        columns={columns}
        data={data?.data ?? []}
        getRowId={(row) => row.id}
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

const columns: ColumnDef<ConnectionLogEntry>[] = [
  {
    id: "user",
    header: "User",
    size: 240,
    cell: ({ row }) => (
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <User className="size-3.5" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {row.original.userName || row.original.userEmail}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {row.original.userEmail}
          </div>
        </div>
      </div>
    ),
  },
  {
    id: "agent",
    header: "Agent",
    size: 180,
    cell: ({ row }) => {
      const client = CLIENTS_BY_ID.get(row.original.clientId);
      return (
        <div className="flex min-w-0 items-center gap-2">
          {client && <ClientIcon client={client} size={22} />}
          <span className="truncate text-sm">
            {INSTALLER_CLIENT_LABELS[row.original.clientId]}
          </span>
          {row.original.disconnectedAt && (
            <Badge
              variant="secondary"
              className="font-normal"
              title={formatDate({ date: row.original.disconnectedAt })}
            >
              Disconnected
            </Badge>
          )}
        </div>
      );
    },
  },
  {
    id: "device",
    header: "Device",
    size: 200,
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="truncate text-sm">
          {row.original.deviceName ?? "Unknown device"}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {PLATFORM_LABEL[row.original.platform]}
        </div>
      </div>
    ),
  },
  {
    id: "setup",
    header: "Connected to",
    size: 260,
    cell: ({ row }) => {
      const { mcpGateway, modelRouting, includeSkills } = row.original;
      const parts = [
        mcpGateway && `Tools: ${mcpGateway.name}`,
        modelRouting && "Model routing",
        includeSkills && "Skills",
      ].filter((part): part is string => Boolean(part));
      return parts.length === 0 ? (
        <span className="text-sm text-muted-foreground">—</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {parts.map((part) => (
            <Badge key={part} variant="outline" className="font-normal">
              {part}
            </Badge>
          ))}
        </div>
      );
    },
  },
  {
    id: "time",
    header: "Time",
    size: 190,
    minSize: 175,
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="text-sm">
          {formatRelativeTimeFromNow(row.original.connectedAt)}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {formatDate({
            date: row.original.connectedAt,
            dateFormat: "MMM d, yyyy · HH:mm:ss",
          })}
        </div>
      </div>
    ),
  },
];
