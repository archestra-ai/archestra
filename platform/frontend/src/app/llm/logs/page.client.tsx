"use client";

import {
  type archestraApiTypes,
  type ClientFilter,
  clientForExternalAgentIds,
  INTERACTION_SOURCE_DISPLAY,
  type InteractionSource,
} from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Database, Layers, MessageSquare, MessagesSquare } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo } from "react";
import { AgentSelector } from "@/components/agent-selector";
import { BilledCost } from "@/components/billed-cost";
import { ClientSourceBadge } from "@/components/client-source-badge";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import { SourceFilterOption } from "@/components/log-filter-option";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { SourceBadge } from "@/components/source-badge";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { DateTimeRangePicker } from "@/components/ui/date-time-range-picker";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UnattributedUserBadge } from "@/components/unattributed-user-badge";
import {
  ClientFilterSelect,
  UserFilterSelect,
} from "@/components/user-client-filter-selects";
import { VirtualKeyBadge } from "@/components/virtual-key-badge";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useDateTimeRangePicker } from "@/lib/hooks/use-date-time-range-picker";
import {
  isSessionId,
  useInteractionSessions,
  useUniqueUserIds,
} from "@/lib/interactions/interaction.query";
import { formatDate, formatRelativeTimeFromNow } from "@/lib/utils";
import { ErrorBoundary } from "../../_parts/error-boundary";

function formatDuration(start: Date | string, end: Date | string): string {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const diffMs = endDate.getTime() - startDate.getTime();

  if (diffMs < 1000) {
    return `${diffMs}ms`;
  }

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0
      ? `${minutes}m ${remainingSeconds}s`
      : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0
      ? `${hours}h ${remainingMinutes}m`
      : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

type SessionData =
  archestraApiTypes.GetInteractionSessionsResponses["200"]["data"][number];

function getSessionDisplayData(session: SessionData) {
  const isSingleInteraction =
    session.sessionId === null && session.interactionId;
  const conversationTitle = session.conversationTitle;
  const isArchestraChat = conversationTitle && session.sessionId;
  const claudeCodeTitle = session.claudeCodeTitle;
  // Known clients (Claude, Codex) get a source badge next to the session's last
  // user message. Derived from the client-attribution column (external_agent_id),
  // not the session-id provenance.
  const clientSource = clientForExternalAgentIds(session.externalAgentIds);

  // Server-computed preview — the sessions API never returns raw request
  // bodies (shipping them OOM-killed the platform container, T-1015).
  const lastUserMessage = session.lastUserMessagePreview ?? "";

  const displayText = claudeCodeTitle || lastUserMessage;

  return {
    isSingleInteraction,
    conversationTitle,
    isArchestraChat,
    clientSource,
    displayText,
  };
}

export default function LlmProxyLogsPage() {
  return (
    <div>
      <ErrorBoundary>
        <SessionsTable />
      </ErrorBoundary>
    </div>
  );
}

function SessionsTable() {
  const router = useRouter();
  const { searchParams, pageIndex, pageSize, offset, updateQueryParams } =
    useDataTableQueryParams();

  // Get URL params
  const profileIdFromUrl = searchParams.get("profileId");
  const userIdFromUrl = searchParams.get("userId");
  const sourceFromUrl = searchParams.get("source");
  const clientFromUrl = searchParams.get("client");
  const startDateFromUrl = searchParams.get("startDate");
  const endDateFromUrl = searchParams.get("endDate");
  const searchFromUrl = searchParams.get("search");
  const profileFilter = profileIdFromUrl || "all";
  const userFilter = userIdFromUrl || "all";
  const sourceFilter = sourceFromUrl || "all";
  const clientFilter = clientFromUrl || "all";

  // The logs search box only filters by session ID (free-text content search
  // was removed). Translate the typed term into a sessionId filter when it is a
  // valid session ID; otherwise it filters nothing and we surface a hint.
  const sessionIdFromSearch =
    searchFromUrl && isSessionId(searchFromUrl) ? searchFromUrl : undefined;
  const searchIsNotSessionId = !!searchFromUrl && !sessionIdFromSearch;

  // Date time range picker hook
  const dateTimePicker = useDateTimeRangePicker({
    startDateFromUrl,
    endDateFromUrl,
    onDateRangeChange: useCallback(
      ({ startDate, endDate }) => {
        updateQueryParams({
          startDate,
          endDate,
          page: "1", // Reset to first page
        });
      },
      [updateQueryParams],
    ),
  });

  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      updateQueryParams({
        page: String(newPagination.pageIndex + 1),
        pageSize: String(newPagination.pageSize),
      });
    },
    [updateQueryParams],
  );

  const handleProfileFilterChange = useCallback(
    (value: string) => {
      updateQueryParams({
        profileId: value === "all" ? null : value,
        page: "1", // Reset to first page
      });
    },
    [updateQueryParams],
  );

  const handleUserFilterChange = useCallback(
    (value: string) => {
      updateQueryParams({
        userId: value === "all" ? null : value,
        page: "1", // Reset to first page
      });
    },
    [updateQueryParams],
  );

  const handleSourceFilterChange = useCallback(
    (value: string) => {
      updateQueryParams({
        source: value === "all" ? null : value,
        page: "1", // Reset to first page
      });
    },
    [updateQueryParams],
  );

  const handleClientFilterChange = useCallback(
    (value: string) => {
      updateQueryParams({
        client: value === "all" ? null : value,
        page: "1", // Reset to first page
      });
    },
    [updateQueryParams],
  );

  const {
    data: sessionsResponse,
    isFetching,
    isLoadingError,
    refetch: refetchSessions,
  } = useInteractionSessions({
    limit: pageSize,
    offset,
    profileId: profileFilter !== "all" ? profileFilter : undefined,
    userId: userFilter !== "all" ? userFilter : undefined,
    source:
      sourceFilter !== "all" ? (sourceFilter as InteractionSource) : undefined,
    client: clientFilter !== "all" ? (clientFilter as ClientFilter) : undefined,
    startDate: dateTimePicker.startDateParam,
    endDate: dateTimePicker.endDateParam,
    sessionId: sessionIdFromSearch,
    toastOnError: false,
  });

  const { data: agents } = useProfiles({
    filters: { agentTypes: ["agent"] },
  });

  const { data: uniqueUsers } = useUniqueUserIds();
  const { data: canSeeAllLogs } = useHasPermissions({ log: ["admin"] });

  const sessions = sessionsResponse?.data ?? [];
  const paginationMeta = sessionsResponse?.pagination;
  const hasFilters =
    profileFilter !== "all" ||
    userFilter !== "all" ||
    sourceFilter !== "all" ||
    clientFilter !== "all" ||
    dateTimePicker.startDate !== undefined ||
    !!searchFromUrl;

  const clearFilters = useCallback(() => {
    dateTimePicker.clearDateRange();
    updateQueryParams({
      profileId: null,
      userId: null,
      source: null,
      client: null,
      startDate: null,
      endDate: null,
      search: null,
      page: "1",
    });
  }, [dateTimePicker, updateQueryParams]);

  const columns: ColumnDef<SessionData>[] = useMemo(
    () => [
      {
        id: "session",
        header: "Session",
        size: 285,
        minSize: 230,
        cell: ({ row }) => {
          const session = row.original;
          const {
            conversationTitle,
            displayText,
            isArchestraChat,
            clientSource,
          } = getSessionDisplayData(session);

          const primaryText = isArchestraChat
            ? conversationTitle
            : displayText ||
              (session.source?.startsWith("knowledge:")
                ? (INTERACTION_SOURCE_DISPLAY[
                    session.source as keyof typeof INTERACTION_SOURCE_DISPLAY
                  ]?.label ?? session.source)
                : "No message");

          return (
            <div className="flex min-w-0 flex-col gap-1.5 py-0.5">
              <div
                className={`truncate text-sm font-medium ${primaryText === "No message" ? "text-muted-foreground" : ""}`}
              >
                {primaryText}
              </div>
              <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                {isArchestraChat ? (
                  <Link
                    href={`/chat/${session.sessionId}`}
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0"
                  >
                    <Badge
                      variant="outline"
                      className="cursor-pointer px-1.5 py-0 text-[10px] hover:bg-accent"
                    >
                      <MessageSquare className="size-3" />
                      Chat
                    </Badge>
                  </Link>
                ) : null}
                {clientSource ? (
                  <ClientSourceBadge
                    client={clientSource}
                    className="shrink-0 px-1.5 py-0 text-[10px]"
                  />
                ) : null}
                {isArchestraChat ? null : (
                  <SessionSourceBadge session={session} compact />
                )}
              </div>
            </div>
          );
        },
      },
      {
        id: "agent",
        // Wider than the other identity columns: this cell stacks the agent,
        // the acting user (or why there is none), and the virtual key's name,
        // and the first two truncate to noise below about this width.
        header: "Agent",
        size: 215,
        minSize: 175,
        cell: ({ row }) => {
          const session = row.original;
          const agent = agents?.find((a) => a.id === session.profileId);
          const isKnowledge = session.source?.startsWith("knowledge:");
          const agentName =
            agent?.name ??
            session.profileName ??
            (isKnowledge
              ? "Knowledge Base"
              : session.profileId === null
                ? "Deleted LLM Proxy"
                : "Unknown");
          return (
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                {isKnowledge ? (
                  <Database className="size-3.5" />
                ) : (
                  <Layers className="size-3.5" />
                )}
              </span>
              <div className="min-w-0 space-y-0.5">
                <div className="truncate text-sm font-medium">{agentName}</div>
                {session.userNames.length > 0 ? (
                  <div className="truncate text-xs text-muted-foreground">
                    {session.userNames.join(", ")}
                  </div>
                ) : (
                  <UnattributedUserBadge reason={session.unattributedReason} />
                )}
                <VirtualKeyBadge virtualKeys={session.virtualKeys} />
              </div>
            </div>
          );
        },
      },
      {
        id: "models",
        header: "Model",
        size: 155,
        minSize: 120,
        cell: ({ row }) => {
          const [model, ...additionalModels] = row.original.models;
          return model ? (
            <div className="min-w-0">
              <div className="truncate font-mono text-xs" title={model}>
                {model}
              </div>
              {additionalModels.length > 0 ? (
                <div className="text-xs text-muted-foreground">
                  +{additionalModels.length} more
                </div>
              ) : null}
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          );
        },
      },
      {
        id: "usage",
        header: "Usage",
        size: 125,
        minSize: 110,
        cell: ({ row }) => {
          const session = row.original;
          const read = session.totalCacheReadTokens;
          const totalInput =
            session.totalInputTokens +
            session.totalCacheReadTokens +
            session.totalCacheWriteTokens;
          const hitRate =
            totalInput > 0 ? Math.round((read / totalInput) * 100) : 0;
          return (
            <div>
              <div className="text-sm tabular-nums">
                {session.requestCount.toLocaleString()}{" "}
                {session.requestCount === 1 ? "request" : "requests"}
              </div>
              <div className="text-xs text-muted-foreground tabular-nums">
                {read > 0 ? `${hitRate}% cache read` : "No cache read"}
              </div>
            </div>
          );
        },
      },
      {
        id: "cost",
        header: "Spend",
        size: 115,
        minSize: 100,
        cell: ({ row }) =>
          row.original.totalCost ? (
            <TooltipProvider>
              <BilledCost
                cost={row.original.totalCost}
                billedCost={row.original.totalBilledCost}
                subscriptionCost={row.original.totalSubscriptionCost}
                baselineCost={
                  row.original.totalBaselineCost || row.original.totalCost
                }
                toonCostSavings={row.original.totalToonCostSavings}
                format="percent"
                tooltip="hover"
                variant="session"
                subscriptionBadge="compact"
              />
            </TooltipProvider>
          ) : null,
      },
      {
        id: "time",
        header: "Last request",
        size: 165,
        minSize: 150,
        cell: ({ row }) => {
          const { firstRequestTime, lastRequestTime, requestCount } =
            row.original;
          if (!lastRequestTime) {
            return <span className="text-xs text-muted-foreground">—</span>;
          }
          const duration =
            requestCount > 1 && firstRequestTime
              ? formatDuration(firstRequestTime, lastRequestTime)
              : null;
          return (
            <div className="min-w-0">
              <div className="text-sm">
                {formatRelativeTimeFromNow(lastRequestTime)}
              </div>
              <div className="truncate font-mono text-[11px] text-muted-foreground">
                {formatDate({
                  date: String(lastRequestTime),
                  dateFormat: "MMM d, yyyy · HH:mm",
                })}
                {duration ? ` · ${duration}` : ""}
              </div>
            </div>
          );
        },
      },
    ],
    [agents],
  );

  // A failed fetch leaves no rows; show a retry state instead of the table's
  // "No LLM proxy logs found" empty message, which would misrepresent the error.
  if (isLoadingError) {
    return (
      <div className="space-y-4">
        <QueryLoadError
          title="Couldn't load logs"
          onRetry={() => refetchSessions()}
        />
      </div>
    );
  }

  return (
    <div>
      <CollectionFilters>
        <FilterBar
          leading
          onClearFilters={hasFilters ? clearFilters : undefined}
        >
          {/* Anchor the "not a session ID" hint as a floating overlay under the
            input so toggling it never reflows the filter bar or the table. */}
          <div className={filterSearchClass}>
            <SearchInput
              isLoading={isFetching}
              objectNamePlural="logs"
              searchFields={["session ID"]}
              paramName="search"
              className="relative w-full"
            />
            {searchIsNotSessionId && (
              <output className="absolute left-0 top-full z-20 mt-1 w-full rounded-md border bg-popover px-2 py-1 text-xs text-muted-foreground shadow-md">
                Enter a valid session UUID
              </output>
            )}
          </div>

          {/* Two people's personal agents can both be called "My Agent", so the
            picker carries each one's scope and owner email rather than a bare
            name. */}
          <AgentSelector
            mode="single"
            flat
            compactTrigger
            agents={agents ?? []}
            value={profileFilter}
            onValueChange={handleProfileFilterChange}
            sentinelOption={{
              value: "all",
              label: "All Agents",
            }}
            // Only reached when the URL pins an id that no longer resolves to an
            // agent (e.g. a bookmarked filter whose target was deleted); the
            // sentinel label covers the ordinary unfiltered state.
            placeholder="Filter by Agent"
            searchPlaceholder="Search agents…"
            emptyMessage="No agents found."
            className={filterControlClass({ active: profileFilter !== "all" })}
          />

          {canSeeAllLogs ? (
            // Without log:admin the server scopes every listing to the caller's
            // own rows, so a user filter would be a one-entry dropdown.
            <UserFilterSelect
              value={userFilter}
              onValueChange={handleUserFilterChange}
              users={uniqueUsers}
            />
          ) : null}

          <FilterSelect
            value={sourceFilter}
            onValueChange={handleSourceFilterChange}
            placeholder="Filter by Source"
            items={[
              { value: "all", label: "All Sources" },
              ...Object.entries(INTERACTION_SOURCE_DISPLAY).map(
                ([value, { label }]) => ({
                  value,
                  label,
                  content: (
                    <SourceFilterOption source={value as InteractionSource} />
                  ),
                  selectedContent: (
                    <SourceFilterOption source={value as InteractionSource} />
                  ),
                }),
              ),
            ]}
          />

          <ClientFilterSelect
            value={clientFilter}
            onValueChange={handleClientFilterChange}
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
        data={sessions}
        hideSelectedCount
        manualPagination
        pagination={{
          pageIndex,
          pageSize,
          total: paginationMeta?.total ?? 0,
        }}
        onPaginationChange={handlePaginationChange}
        isLoading={isFetching}
        hasActiveFilters={hasFilters}
        emptyIcon={MessagesSquare}
        emptyMessage="No LLM proxy logs found. Logs will appear here when agents start making requests."
        filteredEmptyMessage="No LLM logs match your filters"
        onClearFilters={clearFilters}
        onRowClick={(session) => {
          const { isSingleInteraction } = getSessionDisplayData(session);
          if (isSingleInteraction) {
            router.push(`/llm/logs/${session.interactionId}`);
          } else if (session.sessionId) {
            router.push(
              `/llm/logs/session/${encodeURIComponent(session.sessionId)}`,
            );
          }
        }}
      />
    </div>
  );
}

function SessionSourceBadge({
  session,
  compact = false,
}: {
  session: SessionData;
  compact?: boolean;
}) {
  const sources = Array.from(
    new Set(
      session.sources?.filter((source): source is InteractionSource =>
        Boolean(source),
      ) ?? [],
    ),
  );

  if (sources.length <= 1) {
    return (
      <SourceBadge
        source={session.source ?? sources[0]}
        className={
          compact
            ? "max-w-[11rem] min-w-0 overflow-hidden px-1.5 py-0 text-[10px]"
            : "max-w-[11rem] min-w-0 overflow-hidden"
        }
        labelClassName="min-w-0"
      />
    );
  }

  return (
    <Badge
      variant="outline"
      className={
        compact
          ? "max-w-[11rem] min-w-0 overflow-hidden px-1.5 py-0 text-[10px]"
          : "max-w-[11rem] min-w-0 overflow-hidden text-xs"
      }
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Layers className="h-3 w-3 shrink-0" />
        <span className="truncate">Mixed Sources</span>
      </span>
    </Badge>
  );
}
