"use client";

import {
  INSTALLER_CLIENT_IDS,
  INSTALLER_CLIENT_LABELS,
  isInstallerClientId,
} from "@archestra/shared/connection-setup";
import type { ColumnDef } from "@tanstack/react-table";
import { Plug, PlugZap, Unplug } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterControlClass,
} from "@/components/filter-bar";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { DateTimeRangePicker } from "@/components/ui/date-time-range-picker";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import {
  type ConnectionEvent,
  type ConnectionEventAction,
  useConnectionLog,
} from "@/lib/connected-client.query";
import { useCursorPagination } from "@/lib/hooks/use-cursor-pagination";
import { useDateTimeRangePicker } from "@/lib/hooks/use-date-time-range-picker";
import { useMemberSearch } from "@/lib/member.query";
import { formatDate, formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { AgentIcon, agentLabel } from "./agent-icon";

const ALL_VALUE = "all";
const USER_FILTER_LIMIT = 100;

// The action taken, not the agent's state: a connect is logged when the
// installer fetches its setup, before the install on the machine finishes.
const ACTION_LABEL: Record<ConnectionEventAction, string> = {
  connected: "Connect",
  disconnected: "Disconnect",
};

const ACTION_OPTIONS = [
  { value: ALL_VALUE, label: "All actions" },
  { value: "connected", label: ACTION_LABEL.connected },
  { value: "disconnected", label: ACTION_LABEL.disconnected },
];

const AGENT_OPTIONS = [
  { value: ALL_VALUE, label: "All agents" },
  ...INSTALLER_CLIENT_IDS.map((id) => ({
    value: id,
    label: INSTALLER_CLIENT_LABELS[id],
  })),
];

const PLATFORM_LABEL: Record<
  NonNullable<ConnectionEvent["platform"]>,
  string
> = {
  macos: "macOS",
  linux: "Linux",
  windows: "Windows",
};

function parseAction(value: string | null): ConnectionEventAction | undefined {
  return value === "connected" || value === "disconnected" ? value : undefined;
}

/**
 * Each time a member connected an agent through the Connect page, and each
 * time one was disconnected.
 */
export function ConnectionLogTable() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const userId = searchParams.get("userId") ?? undefined;
  const agentParam = searchParams.get("agent");
  const clientId =
    agentParam && isInstallerClientId(agentParam) ? agentParam : undefined;
  const action = parseAction(searchParams.get("action"));

  const cursorPagination = useCursorPagination({
    defaultPageSize: DEFAULT_TABLE_LIMIT,
  });

  const updateUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") params.delete(key);
        else params.set(key, value);
      }
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  // Any filter change starts over from the newest event.
  const filterChange = useCallback(
    (key: string) => (value: string) => {
      cursorPagination.goNewest();
      updateUrlParams({ [key]: value === ALL_VALUE ? null : value });
    },
    [cursorPagination.goNewest, updateUrlParams],
  );

  const dateTimePicker = useDateTimeRangePicker({
    startDateFromUrl: searchParams.get("startDate"),
    endDateFromUrl: searchParams.get("endDate"),
    onDateRangeChange: useCallback(
      ({ startDate, endDate }) => {
        cursorPagination.goNewest();
        updateUrlParams({ startDate, endDate });
      },
      [cursorPagination.goNewest, updateUrlParams],
    ),
  });

  const { data, isFetching, isLoadingError, refetch } = useConnectionLog({
    limit: cursorPagination.pageSize,
    cursor: cursorPagination.cursor ?? undefined,
    userId,
    clientId,
    action,
    startDate: dateTimePicker.startDateParam,
    endDate: dateTimePicker.endDateParam,
  });

  const {
    users,
    onSearchQueryChange: onUserSearchChange,
    emptyMessage: userEmptyMessage,
  } = useMemberSearch({
    limit: USER_FILTER_LIMIT,
    selectedUserIds: userId ? [userId] : [],
  });
  const userOptions = useMemo(
    () =>
      users.map((user) => ({
        value: user.userId,
        label: user.name || user.email || "Unknown",
        description: user.name ? (user.email ?? undefined) : undefined,
      })),
    [users],
  );

  const hasFilters =
    userId !== undefined ||
    clientId !== undefined ||
    action !== undefined ||
    dateTimePicker.startDate !== undefined ||
    dateTimePicker.endDate !== undefined;

  const clearFilters = useCallback(() => {
    cursorPagination.goNewest();
    dateTimePicker.clearDateRange();
    updateUrlParams({
      userId: null,
      agent: null,
      action: null,
      startDate: null,
      endDate: null,
    });
  }, [cursorPagination.goNewest, dateTimePicker, updateUrlParams]);

  if (isLoadingError) {
    return (
      <div className="space-y-4">
        <QueryLoadError
          title="Couldn't load agent connections"
          onRetry={() => refetch()}
        />
      </div>
    );
  }

  const paginationMeta = data?.pagination;

  return (
    <div>
      <CollectionFilters>
        <FilterBar
          leading
          onClearFilters={hasFilters ? clearFilters : undefined}
        >
          <FilterSelect
            value={userId ?? ALL_VALUE}
            onValueChange={filterChange("userId")}
            placeholder="Filter by user"
            items={userOptions}
            pinnedItems={[{ value: ALL_VALUE, label: "All users" }]}
            onSearchQueryChange={onUserSearchChange}
            emptyMessage={userEmptyMessage}
            inactiveValue={ALL_VALUE}
          />
          <FilterSelect
            value={clientId ?? ALL_VALUE}
            onValueChange={filterChange("agent")}
            placeholder="Filter by agent"
            items={AGENT_OPTIONS}
            inactiveValue={ALL_VALUE}
          />
          <FilterSelect
            value={action ?? ALL_VALUE}
            onValueChange={filterChange("action")}
            placeholder="Filter by action"
            items={ACTION_OPTIONS}
            inactiveValue={ALL_VALUE}
          />
          <DateTimeRangePicker
            startDate={dateTimePicker.startDate}
            endDate={dateTimePicker.endDate}
            isDialogOpen={dateTimePicker.isDateDialogOpen}
            tempStartDate={dateTimePicker.tempStartDate}
            tempEndDate={dateTimePicker.tempEndDate}
            displayText={dateTimePicker.getDateRangeDisplay()}
            onDialogOpenChange={dateTimePicker.setIsDateDialogOpen}
            onTempStartDateChange={dateTimePicker.setTempStartDate}
            onTempEndDateChange={dateTimePicker.setTempEndDate}
            onOpenDialog={dateTimePicker.openDateDialog}
            onApply={dateTimePicker.handleApplyDateRange}
            className={filterControlClass({
              active: dateTimePicker.startDate !== undefined,
            })}
          />
        </FilterBar>
      </CollectionFilters>

      <DataTable
        columns={columns}
        data={data?.data ?? []}
        getRowId={(row) => row.id}
        hideSelectedCount
        cursorPagination={
          paginationMeta
            ? {
                pageIndex: cursorPagination.pageIndex,
                pageSize: cursorPagination.pageSize,
                hasNext: paginationMeta.hasNext,
                canGoNewer: cursorPagination.canGoNewer,
                onPageSizeChange: cursorPagination.setPageSize,
                onNewer: cursorPagination.goNewer,
                onOlder: () =>
                  cursorPagination.goOlder(paginationMeta.nextCursor),
              }
            : undefined
        }
        manualPagination
        isLoading={isFetching}
        hasActiveFilters={hasFilters}
        emptyIcon={PlugZap}
        emptyMessage="No agent connections yet. They will appear here when members connect an agent from the Connect page."
        filteredEmptyMessage="No agent connections match your filters"
        onClearFilters={clearFilters}
      />
    </div>
  );
}

const columns: ColumnDef<ConnectionEvent>[] = [
  {
    id: "event",
    header: "Event",
    size: 190,
    minSize: 160,
    cell: ({ row }) => {
      const { action, disconnectedBy, occurredAt } = row.original;
      const Icon = action === "connected" ? Plug : Unplug;
      return (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-sm">
            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="font-medium">{ACTION_LABEL[action]}</span>
            <span className="truncate text-muted-foreground">
              {formatRelativeTimeFromNow(occurredAt)}
            </span>
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {formatDate({
              date: occurredAt,
              dateFormat: "MMM d, yyyy · HH:mm",
            })}
            {disconnectedBy ? ` · by ${disconnectedBy.name}` : ""}
          </div>
        </div>
      );
    },
  },
  {
    id: "user",
    header: "User",
    size: 220,
    minSize: 170,
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">
          {row.original.userName || row.original.userEmail}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {row.original.userEmail}
        </div>
      </div>
    ),
  },
  {
    id: "agent",
    header: "Agent",
    size: 200,
    minSize: 160,
    cell: ({ row }) => {
      const { clientId, agentName, deviceName, platform } = row.original;
      const agent = { clientId, name: agentName };
      const machine = [deviceName, platform && PLATFORM_LABEL[platform]]
        .filter(Boolean)
        .join(" · ");
      return (
        <div className="flex min-w-0 items-center gap-2">
          <AgentIcon agent={agent} />
          <div className="min-w-0">
            <div className="truncate text-sm">{agentLabel(agent)}</div>
            {machine ? (
              <div className="truncate text-xs text-muted-foreground">
                {machine}
              </div>
            ) : null}
          </div>
        </div>
      );
    },
  },
  {
    id: "setup",
    header: "Included",
    size: 240,
    minSize: 160,
    cell: ({ row }) => {
      const { via, mcpGateway, modelRouting, includeSkills } = row.original;
      const parts = [
        via === "oauthSignIn" && "Gateway sign-in",
        mcpGateway && `Tools: ${mcpGateway.name}`,
        modelRouting && "Model routing",
        includeSkills && "Skills",
      ].filter((part): part is string => Boolean(part));
      return parts.length === 0 ? (
        <div className="text-xs text-muted-foreground">—</div>
      ) : (
        <div className="flex flex-wrap gap-1">
          {parts.map((part) => (
            <Badge
              key={part}
              variant="outline"
              className="px-1.5 py-0 text-[10px] font-normal"
            >
              {part}
            </Badge>
          ))}
        </div>
      );
    },
  },
];
