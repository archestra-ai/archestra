"use client";

import {
  type archestraApiTypes,
  INTERACTION_SOURCE_DISPLAY,
  type InteractionSource,
} from "@shared";
import { Database, Layers, MessageSquare, User } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { Savings } from "@/components/savings";
import { SearchInput } from "@/components/search-input";
import { SourceBadge } from "@/components/source-badge";
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
import {
  useInteractionSessions,
  useUniqueUserIds,
} from "@/lib/interaction.query";
import { DynamicInteraction } from "@/lib/interaction.utils";
import { useDateTimeRangePicker } from "@/lib/use-date-time-range-picker";
import { DEFAULT_TABLE_LIMIT, formatDate } from "@/lib/utils";
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
  const searchParams = useSearchParams();
  const pathname = usePathname();

  // Get URL params
  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");
  const profileIdFromUrl = searchParams.get("profileId");
  const userIdFromUrl = searchParams.get("userId");
  const sourceFromUrl = searchParams.get("source");
  const startDateFromUrl = searchParams.get("startDate");
  const endDateFromUrl = searchParams.get("endDate");
  const searchFromUrl = searchParams.get("search");

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || DEFAULT_TABLE_LIMIT);

  const [profileFilter, setProfileFilter] = useState(profileIdFromUrl || "all");
  const [userFilter, setUserFilter] = useState(userIdFromUrl || "all");
  const [sourceFilter, setSourceFilter] = useState(sourceFromUrl || "all");

  // Helper to update URL params
  const updateUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      Object.entries(updates).forEach(([key, value]) => {
        if (value === null || value === "" || value === "all") {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      });
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  // Date time range picker hook
  const dateTimePicker = useDateTimeRangePicker({
    startDateFromUrl,
    endDateFromUrl,
    onDateRangeChange: useCallback(
      ({ startDate, endDate }) => {
        updateUrlParams({
          startDate,
          endDate,
          page: "1", // Reset to first page
        });
      },
      [updateUrlParams],
    ),
  });

  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      updateUrlParams({
        page: String(newPagination.pageIndex + 1),
        pageSize: String(newPagination.pageSize),
      });
    },
    [updateUrlParams],
  );

  const handleProfileFilterChange = useCallback(
    (value: string) => {
      setProfileFilter(value);
      updateUrlParams({
        profileId: value === "all" ? null : value,
        page: "1", // Reset to first page
      });
    },
    [updateUrlParams],
  );

  const handleUserFilterChange = useCallback(
    (value: string) => {
      setUserFilter(value);
      updateUrlParams({
        userId: value === "all" ? null : value,
        page: "1", // Reset to first page
      });
    },
    [updateUrlParams],
  );

  const handleSourceFilterChange = useCallback(
    (value: string) => {
      setSourceFilter(value);
      updateUrlParams({
        source: value === "all" ? null : value,
        page: "1", // Reset to first page
      });
    },
    [updateUrlParams],
  );

  const { data: sessionsResponse, isFetching } = useInteractionSessions({
    limit: pageSize,
    offset: pageIndex * pageSize,
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
    dateTimePicker.dateRange !== undefined ||
    !!searchFromUrl;

  const clearFilters = useCallback(() => {
    setProfileFilter("all");
    setUserFilter("all");
    setSourceFilter("all");
    dateTimePicker.clearDateRange();
    updateUrlParams({
      profileId: null,
      userId: null,
      source: null,
      startDate: null,
      endDate: null,
      search: null,
      page: "1",
    });
  }, [dateTimePicker, updateUrlParams]);

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
                    {conversationTitle.length > 60
                      ? `${conversationTitle.slice(0, 60)}...`
                      : conversationTitle}
                  </span>
                  <Link
                    href={`/chat?conversation=${session.sessionId}`}
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
                  {INTERACTION_SOURCE_DISPLAY[session.source]?.label ??
                    session.source}
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
        cell: ({ row }) => <SourceBadge source={row.original.source} />,
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
      <div className="flex flex-wrap gap-4">
        <SearchInput placeholder="Search sessions..." paramName="search" />

        <SearchableSelect
          value={profileFilter}
          onValueChange={handleProfileFilterChange}
          placeholder="Filter by Profile"
          items={[
            { value: "all", label: "All Agents & LLM Proxies" },
            ...(agents?.map((agent) => ({
              value: agent.id,
              label: agent.name,
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
            ...(uniqueUsers?.map((user) => ({
              value: user.id,
              label: user.name || user.id,
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
              ([value, { label }]) => ({ value, label }),
            ),
          ]}
          className="w-[200px]"
        />

        <DateTimeRangePicker
          dateRange={dateTimePicker.dateRange}
          isDialogOpen={dateTimePicker.isDateDialogOpen}
          tempDateRange={dateTimePicker.tempDateRange}
          fromTime={dateTimePicker.fromTime}
          toTime={dateTimePicker.toTime}
          displayText={dateTimePicker.getDateRangeDisplay()}
          onDialogOpenChange={dateTimePicker.setIsDateDialogOpen}
          onTempDateRangeChange={dateTimePicker.setTempDateRange}
          onFromTimeChange={dateTimePicker.setFromTime}
          onToTimeChange={dateTimePicker.setToTime}
          onOpenDialog={dateTimePicker.openDateDialog}
          onApply={dateTimePicker.handleApplyDateRange}
          idPrefix="llm-proxy-"
        />
      </div>

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
        filteredEmptyMessage="No results match your filters. Try adjusting your search."
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
