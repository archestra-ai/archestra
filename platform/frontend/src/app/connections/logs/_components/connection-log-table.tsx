"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Plug, PlugZap, Unplug } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo } from "react";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
} from "@/components/filter-bar";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import {
  type ConnectionEvent,
  type ConnectionEventAction,
  useConnectionLog,
} from "@/lib/connected-client.query";
import { useCursorPagination } from "@/lib/hooks/use-cursor-pagination";
import { useMemberSearch } from "@/lib/member.query";
import { formatDate, formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { AgentIcon, agentLabel } from "./agent-icon";
import type { ConnectionsWindow } from "./connections-window";

const ALL_VALUE = "all";
const USER_FILTER_LIMIT = 100;

// The action taken, not the agent's state: a connect is logged when the
// installer fetches its setup, before the install on the machine finishes.
const ACTION_LABEL: Record<ConnectionEventAction, string> = {
  connected: "Connect",
  disconnected: "Disconnect",
};

const ACTION_OPTIONS = [
  { value: ALL_VALUE, label: "All events" },
  { value: "connected", label: ACTION_LABEL.connected },
  { value: "disconnected", label: ACTION_LABEL.disconnected },
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
export function ConnectionLogTable({ window }: { window: ConnectionsWindow }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const userId = searchParams.get("userId") ?? undefined;
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

  // A new page-wide range starts over from the newest event.
  const { goNewest } = cursorPagination;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on a range change
  useEffect(() => {
    goNewest();
  }, [window.startDate, window.endDate, goNewest]);

  const { data, isFetching, isLoadingError, refetch } = useConnectionLog({
    limit: cursorPagination.pageSize,
    cursor: cursorPagination.cursor ?? undefined,
    userId,
    action,
    startDate: window.startDate,
    endDate: window.endDate,
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

  const hasFilters = userId !== undefined || action !== undefined;

  const clearFilters = useCallback(() => {
    cursorPagination.goNewest();
    updateUrlParams({ userId: null, action: null });
  }, [cursorPagination.goNewest, updateUrlParams]);

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
        <FilterBar onClearFilters={hasFilters ? clearFilters : undefined}>
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
            value={action ?? ALL_VALUE}
            onValueChange={filterChange("action")}
            placeholder="Filter by action"
            items={ACTION_OPTIONS}
            inactiveValue={ALL_VALUE}
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
        emptyMessage={`No agent connections in ${window.picked ? "this date range" : `the ${window.label}`}. They appear here when members connect an agent from the Connect page.`}
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
    id: "added",
    header: "Added",
    size: 240,
    minSize: 160,
    cell: ({ row }) => {
      const added = addedTo(row.original);
      return added.length === 0 ? (
        <div className="text-xs text-muted-foreground">—</div>
      ) : (
        <div className="flex flex-wrap gap-1">
          {added.map(({ label, detail }) => (
            <Tooltip key={label}>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className="cursor-default px-1.5 py-0 text-[10px] font-normal"
                >
                  {label}
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">{detail}</TooltipContent>
            </Tooltip>
          ))}
        </div>
      );
    },
  },
];

/**
 * What connecting gave the agent, each named in its tooltip as "label: value"
 * so a gateway called "My Gateway" never reads as a stutter. A disconnect adds
 * nothing. An agent that signed in to the gateway itself gets its tools from
 * it, but which gateway is only known once it calls a tool.
 */
function addedTo(event: ConnectionEvent): { label: string; detail: string }[] {
  if (event.action === "disconnected") return [];
  const added: { label: string; detail: string }[] = [];
  if (event.mcpGateway || event.via === "oauthSignIn") {
    added.push({
      label: "MCP gateway",
      detail: `MCP gateway: ${event.mcpGateway?.name ?? "not known yet"}`,
    });
  }
  if (event.llmProxy) {
    added.push({
      label: "LLM proxy",
      detail: `LLM proxy: ${event.llmProxy.name}`,
    });
  }
  if (event.includeSkills) {
    const count = event.skillCount;
    added.push({
      label: "Skills",
      detail: count > 0 ? `Skills: ${count} added` : "Skills: added",
    });
  }
  return added;
}
