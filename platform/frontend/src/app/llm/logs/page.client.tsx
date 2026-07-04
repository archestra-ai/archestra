"use client";

import {
  type archestraApiTypes,
  CLAUDE_CLIENT_LABEL,
  CLIENT_FILTER_OPTIONS,
  type ClientFilter,
  DynamicInteraction,
  INTERACTION_SOURCE_DISPLAY,
  type InteractionSource,
  isClaudeClientAgentId,
} from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Database, Layers, MessageSquare, User } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo } from "react";
import {
  ClientFilterOption,
  ProfileFilterOption,
  SourceFilterOption,
  UserFilterOption,
} from "@/components/log-filter-option";
import { QueryLoadError } from "@/components/query-load-error";
import { Savings } from "@/components/savings";
import { SearchInput } from "@/components/search-input";
import { SourceBadge } from "@/components/source-badge";
import { TableFilters } from "@/components/table-filters";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { DateTimeRangePicker } from "@/components/ui/date-time-range-picker";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProfiles } from "@/lib/agent.query";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useDateTimeRangePicker } from "@/lib/hooks/use-date-time-range-picker";
import {
  isSessionId,
  useInteractionSessions,
  useUniqueUserIds,
} from "@/lib/interactions/interaction.query";
import { formatDate } from "@/lib/utils";
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
type UniqueUser = archestraApiTypes.GetUniqueUserIdsResponses["200"][number];

function getSessionDisplayData(session: SessionData) {
  const isSingleInteraction =
    session.sessionId === null && session.interactionId;
  const conversationTitle = session.conversationTitle;
  const isArchestraChat = conversationTitle && session.sessionId;
  const claudeCodeTitle = session.claudeCodeTitle;
  // Claude clients get a source badge and a labelled placeholder; other clients
  // fall back to the last user message. Derived from the client-attribution
  // column (external_agent_id), not the session-id provenance.
  const claudeSourceLabel = session.externalAgentIds.some(isClaudeClientAgentId)
    ? CLAUDE_CLIENT_LABEL
    : null;

  let lastUserMessage = "";
  if (session.lastInteractionRequest && session.lastInteractionType) {
    try {
      const mockInteraction = {
        request: session.lastInteractionRequest,
        response: {},
        type: session.lastInteractionType,
      };
      const interaction = new DynamicInteraction(
        mockInteraction as archestraApiTypes.GetInteractionResponses["200"],
      );
      lastUserMessage = interaction.getLastUserMessage();
    } catch {
      lastUserMessage = "";
    }
  }

  const displayText = claudeCodeTitle || lastUserMessage;

  return {
    isSingleInteraction,
    conversationTitle,
    isArchestraChat,
    claudeSourceLabel,
    lastUserMessage,
    displayText,
  };
}

export default function LlmProxyLogsPage({
  initialData,
}: {
  initialData?: {
    interactions: archestraApiTypes.GetInteractionsResponses["200"];
    agents: archestraApiTypes.GetAllAgentsResponses["200"];
  };
}) {
  return (
    <div>
      <ErrorBoundary>
        <SessionsTable initialData={initialData} />
      </ErrorBoundary>
    </div>
  );
}

function SessionsTable({
  initialData,
}: {
  initialData?: {
    interactions: archestraApiTypes.GetInteractionsResponses["200"];
    agents: archestraApiTypes.GetAllAgentsResponses["200"];
  };
}) {
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
    initialData: initialData?.agents,
    filters: { agentTypes: ["agent", "llm_proxy"] },
  });

  const { data: uniqueUsers } = useUniqueUserIds();

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
        size: 300,
        minSize: 220,
        cell: ({ row }) => {
          const session = row.original;
          const {
            conversationTitle,
            displayText,
            isArchestraChat,
            claudeSourceLabel,
            lastUserMessage,
          } = getSessionDisplayData(session);

          return (
            <div className="flex max-w-full min-w-0 items-center gap-2 overflow-hidden text-xs">
              {isArchestraChat ? (
                <>
                  <span className="min-w-0 flex-1 truncate">
                    {(conversationTitle ?? "").length > 60
                      ? `${(conversationTitle ?? "").slice(0, 60)}...`
                      : conversationTitle}
                  </span>
                  <Link
                    href={`/chat/${session.sessionId}`}
                    onClick={(e) => e.stopPropagation()}
                    className="shrink-0"
                  >
                    <Badge
                      variant="outline"
                      className="text-xs hover:bg-accent cursor-pointer"
                    >
                      <MessageSquare className="h-3 w-3 mr-1" />
                      Chat
                    </Badge>
                  </Link>
                </>
              ) : claudeSourceLabel ? (
                <>
                  <span className="min-w-0 flex-1 truncate">
                    {displayText
                      ? displayText.length > 80
                        ? `${displayText.slice(0, 80)}...`
                        : displayText
                      : `${claudeSourceLabel} session`}
                  </span>
                  <Badge
                    variant="secondary"
                    className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300 shrink-0"
                  >
                    {claudeSourceLabel}
                  </Badge>
                </>
              ) : lastUserMessage ? (
                <span className="min-w-0 max-w-full truncate">
                  {lastUserMessage.length > 80
                    ? `${lastUserMessage.slice(0, 80)}...`
                    : lastUserMessage}
                </span>
              ) : session.source?.startsWith("knowledge:") ? (
                <span className="min-w-0 max-w-full truncate text-muted-foreground">
                  {INTERACTION_SOURCE_DISPLAY[
                    session.source as keyof typeof INTERACTION_SOURCE_DISPLAY
                  ]?.label ?? session.source}
                </span>
              ) : (
                <span className="min-w-0 max-w-full truncate text-muted-foreground">
                  No message
                </span>
              )}
            </div>
          );
        },
      },
      {
        id: "requests",
        header: "Requests",
        size: 96,
        minSize: 88,
        cell: ({ row }) => (
          <span className="font-mono text-xs">
            {row.original.requestCount.toLocaleString()}
          </span>
        ),
      },
      {
        id: "cache",
        header: "Cache read",
        size: 120,
        minSize: 96,
        cell: ({ row }) => {
          const read = row.original.totalCacheReadTokens;
          const write = row.original.totalCacheWriteTokens;
          if (read === 0 && write === 0) {
            return <span className="text-muted-foreground text-xs">—</span>;
          }
          const totalInput = row.original.totalInputTokens + read + write;
          const hitRate =
            totalInput > 0 ? Math.round((read / totalInput) * 100) : 0;
          return (
            <span className="font-mono text-xs">
              {hitRate}% · {read.toLocaleString()}
            </span>
          );
        },
      },
      {
        id: "models",
        header: "Models",
        cell: ({ row }) => (
          <TooltipProvider>
            <div className="flex flex-wrap gap-1 min-w-0 max-w-full overflow-hidden">
              {row.original.models.map((model) => (
                <Tooltip key={model}>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="secondary"
                      className="text-xs max-w-full cursor-default inline-block truncate"
                    >
                      {model}
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="font-mono text-xs">{model}</p>
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          </TooltipProvider>
        ),
      },
      {
        id: "cost",
        header: "Cost",
        cell: ({ row }) =>
          row.original.totalCost ? (
            <TooltipProvider>
              <Savings
                cost={row.original.totalCost}
                baselineCost={
                  row.original.totalBaselineCost || row.original.totalCost
                }
                toonCostSavings={row.original.totalToonCostSavings}
                format="percent"
                tooltip="hover"
                variant="session"
              />
            </TooltipProvider>
          ) : null,
      },
      {
        id: "source",
        header: "Source",
        size: 220,
        minSize: 170,
        cell: ({ row }) => (
          <div className="max-w-full min-w-0 overflow-hidden">
            <SessionSourceBadge session={row.original} />
          </div>
        ),
      },
      {
        id: "time",
        header: "Time",
        size: 160,
        minSize: 145,
        cell: ({ row }) => (
          <div className="flex min-w-0 flex-col gap-0.5 font-mono text-xs">
            {row.original.lastRequestTime && (
              <span>
                {formatDate({ date: String(row.original.lastRequestTime) })}
              </span>
            )}
            {row.original.requestCount > 1 &&
              row.original.firstRequestTime &&
              row.original.lastRequestTime && (
                <span className="text-muted-foreground">
                  {formatDuration(
                    row.original.firstRequestTime,
                    row.original.lastRequestTime,
                  )}
                </span>
              )}
          </div>
        ),
      },
      {
        id: "details",
        header: "Details",
        size: 280,
        minSize: 220,
        cell: ({ row }) => {
          const agent = agents?.find((a) => a.id === row.original.profileId);
          return (
            <div className="flex max-w-full min-w-0 flex-wrap gap-1 overflow-hidden">
              <Badge variant="secondary" className="min-w-0 max-w-full text-xs">
                {row.original.source?.startsWith("knowledge:") ? (
                  <Database className="h-3 w-3 mr-1 shrink-0" />
                ) : (
                  <Layers className="h-3 w-3 mr-1 shrink-0" />
                )}
                <span className="min-w-0 truncate">
                  {agent?.name ??
                    row.original.profileName ??
                    (row.original.source?.startsWith("knowledge:")
                      ? "Knowledge Base"
                      : row.original.profileId === null
                        ? "Deleted LLM Proxy"
                        : "Unknown")}
                </span>
              </Badge>
              {row.original.userNames.map((userName) => (
                <Badge
                  key={userName}
                  variant="outline"
                  className="min-w-0 max-w-full text-xs"
                >
                  <User className="h-3 w-3 mr-1 shrink-0" />
                  <span className="min-w-0 truncate">{userName}</span>
                </Badge>
              ))}
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
    <div className="space-y-4">
      <TableFilters>
        {/* Anchor the "not a session ID" hint as a floating overlay under the
            input so toggling it never reflows the filter bar or the table. */}
        <div className="relative w-full sm:w-[320px] sm:max-w-[320px]">
          <SearchInput
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

        <SearchableSelect
          value={profileFilter}
          onValueChange={handleProfileFilterChange}
          placeholder="Filter by Profile"
          items={[
            { value: "all", label: "All Agents & LLM Proxies" },
            ...(agents?.map((agent) => ({
              value: agent.id,
              label: agent.name,
              content: <ProfileFilterOption profile={agent} />,
              selectedContent: <ProfileFilterOption profile={agent} />,
            })) || []),
          ]}
          className="w-[200px]"
        />

        <SearchableSelect
          value={userFilter}
          onValueChange={handleUserFilterChange}
          placeholder="Filter by User"
          items={[
            { value: "all", label: "All Users" },
            ...(uniqueUsers?.map((user: UniqueUser) => ({
              value: user.id,
              label: user.name || user.id,
              content: <UserFilterOption name={user.name || user.id} />,
              selectedContent: <UserFilterOption name={user.name || user.id} />,
            })) || []),
          ]}
          className="w-[200px]"
        />

        <SearchableSelect
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
          className="w-[200px]"
        />

        <SearchableSelect
          value={clientFilter}
          onValueChange={handleClientFilterChange}
          placeholder="Filter by Client"
          items={[
            { value: "all", label: "All Clients" },
            ...CLIENT_FILTER_OPTIONS.map(({ value, label }) => ({
              value,
              label,
              content: <ClientFilterOption label={label} />,
              selectedContent: <ClientFilterOption label={label} />,
            })),
          ]}
          className="w-[200px]"
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
        />
      </TableFilters>

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
        emptyMessage="No LLM proxy logs found. Logs will appear here when agents start making requests."
        filteredEmptyMessage="No LLM logs match your filters. Try adjusting your search."
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

function SessionSourceBadge({ session }: { session: SessionData }) {
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
        className="max-w-[11rem] min-w-0 overflow-hidden"
        labelClassName="min-w-0"
      />
    );
  }

  return (
    <Badge
      variant="outline"
      className="max-w-[11rem] min-w-0 overflow-hidden text-xs"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Layers className="h-3 w-3 shrink-0" />
        <span className="truncate">Mixed Sources</span>
      </span>
    </Badge>
  );
}
