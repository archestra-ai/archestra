"use client";

import {
  type archestraApiTypes,
  INTERACTION_SOURCE_DISPLAY,
  type InteractionSource,
} from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Database, Layers, MessageSquare, User } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo } from "react";
import {
  ProfileFilterOption,
  SourceFilterOption,
  UserFilterOption,
} from "@/components/log-filter-option";
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
  useInteractionSessions,
  useUniqueUserIds,
} from "@/lib/interactions/interaction.query";
import { DynamicInteraction } from "@/lib/interactions/interaction.utils";
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
  const isClaudeCodeSession = session.sessionSource === "claude_code";

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
    isClaudeCodeSession,
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
  const startDateFromUrl = searchParams.get("startDate");
  const endDateFromUrl = searchParams.get("endDate");
  const searchFromUrl = searchParams.get("search");
  const profileFilter = profileIdFromUrl || "all";
  const userFilter = userIdFromUrl || "all";
  const sourceFilter = sourceFromUrl || "all";

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

  const { data: sessionsResponse, isFetching } = useInteractionSessions({
    limit: pageSize,
    offset,
    profileId: profileFilter !== "all" ? profileFilter : undefined,
    userId: userFilter !== "all" ? userFilter : undefined,
    source:
      sourceFilter !== "all" ? (sourceFilter as InteractionSource) : undefined,
    startDate: dateTimePicker.startDateParam,
    endDate: dateTimePicker.endDateParam,
    search: searchFromUrl || undefined,
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
    dateTimePicker.startDate !== undefined ||
    !!searchFromUrl;

  const clearFilters = useCallback(() => {
    dateTimePicker.clearDateRange();
    updateQueryParams({
      profileId: null,
      userId: null,
      source: null,
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
        cell: ({ row }) => {
          const session = row.original;
          const {
            conversationTitle,
            displayText,
            isArchestraChat,
            isClaudeCodeSession,
            lastUserMessage,
          } = getSessionDisplayData(session);

          return (
            <div className="flex items-center gap-1 text-xs">
              {isArchestraChat ? (
                <>
                  <span className="truncate">
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
              ) : isClaudeCodeSession ? (
                <>
                  <span className="truncate">
                    {displayText
                      ? displayText.length > 80
                        ? `${displayText.slice(0, 80)}...`
                        : displayText
                      : "Claude Code session"}
                  </span>
                  <Badge
                    variant="secondary"
                    className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300 shrink-0"
                  >
                    Claude Code
                  </Badge>
                </>
              ) : lastUserMessage ? (
                <span>
                  {lastUserMessage.length > 80
                    ? `${lastUserMessage.slice(0, 80)}...`
                    : lastUserMessage}
                </span>
              ) : session.source?.startsWith("knowledge:") ? (
                <span className="text-muted-foreground">
                  {INTERACTION_SOURCE_DISPLAY[
                    session.source as keyof typeof INTERACTION_SOURCE_DISPLAY
                  ]?.label ?? session.source}
                </span>
              ) : (
                <span className="text-muted-foreground">No message</span>
              )}
            </div>
          );
        },
      },
      {
        id: "requests",
        header: "Requests",
        cell: ({ row }) => (
          <span className="font-mono text-xs">
            {row.original.requestCount.toLocaleString()}
          </span>
        ),
      },
      {
        id: "models",
        header: "Models",
        cell: ({ row }) => (
          <TooltipProvider>
            <div className="flex flex-wrap gap-1">
              {row.original.models.map((model) => (
                <Tooltip key={model}>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="secondary"
                      className="text-xs max-w-[180px] cursor-default"
                    >
                      <span className="truncate">{model}</span>
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
        cell: ({ row }) => (
          <SourceBadge
            source={row.original.source}
            className="max-w-[12.5rem]"
          />
        ),
      },
      {
        id: "time",
        header: "Time",
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5 font-mono text-xs">
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
        cell: ({ row }) => {
          const agent = agents?.find((a) => a.id === row.original.profileId);
          return (
            <div className="flex flex-wrap gap-1">
              <Badge variant="secondary" className="text-xs max-w-[200px]">
                {row.original.source?.startsWith("knowledge:") ? (
                  <Database className="h-3 w-3 mr-1 shrink-0" />
                ) : (
                  <Layers className="h-3 w-3 mr-1 shrink-0" />
                )}
                <span className="truncate">
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
                  className="text-xs max-w-[150px]"
                >
                  <User className="h-3 w-3 mr-1 shrink-0" />
                  <span className="truncate">{userName}</span>
                </Badge>
              ))}
            </div>
          );
        },
      },
    ],
    [agents],
  );

  return (
    <div className="space-y-4">
      <TableFilters>
        <SearchInput
          objectNamePlural="logs"
          searchFields={["session ID", "model", "message"]}
          paramName="search"
        />

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
