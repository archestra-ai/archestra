"use client";

import type { archestraApiTypes } from "@shared";
import { Layers, MessageSquare, Search, User } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { DebouncedInput } from "@/components/debounced-input";
import { Savings } from "@/components/savings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateTimeRangePicker } from "@/components/ui/date-time-range-picker";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TooltipProvider } from "@/components/ui/tooltip";
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

function Pagination({
  pageIndex,
  pageSize,
  total,
  onPaginationChange,
}: {
  pageIndex: number;
  pageSize: number;
  total: number;
  onPaginationChange: (params: { pageIndex: number; pageSize: number }) => void;
}) {
  const totalPages = Math.ceil(total / pageSize);
  const canPrevious = pageIndex > 0;
  const canNext = pageIndex < totalPages - 1;

  return (
    <div className="flex items-center justify-between px-2 py-4">
      <div className="text-sm text-muted-foreground">
        Showing {pageIndex * pageSize + 1} to{" "}
        {Math.min((pageIndex + 1) * pageSize, total)} of {total} results
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            onPaginationChange({ pageIndex: pageIndex - 1, pageSize })
          }
          disabled={!canPrevious}
        >
          Previous
        </Button>
        <span className="text-sm">
          Page {pageIndex + 1} of {totalPages}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            onPaginationChange({ pageIndex: pageIndex + 1, pageSize })
          }
          disabled={!canNext}
        >
          Next
        </Button>
      </div>
    </div>
  );
}

function SessionRow({
  session,
  agents,
}: {
  session: SessionData;
  agents: archestraApiTypes.GetAllAgentsResponses["200"] | undefined;
}) {
  const router = useRouter();

  const agent = agents?.find((a) => a.id === session.profileId);
  const isSingleInteraction =
    session.sessionId === null && session.interactionId;

  // Extract last user message from the last interaction's request
  const lastUserMessage = useMemo(() => {
    if (!session.lastInteractionRequest || !session.lastInteractionType) {
      return "";
    }
    try {
      // Create a mock interaction object for DynamicInteraction
      const mockInteraction = {
        request: session.lastInteractionRequest,
        response: {},
        type: session.lastInteractionType,
      };
      const interaction = new DynamicInteraction(
        mockInteraction as archestraApiTypes.GetInteractionResponses["200"],
      );
      return interaction.getLastUserMessage();
    } catch {
      return "";
    }
  }, [session.lastInteractionRequest, session.lastInteractionType]);

  // For single interactions (no session), navigate directly to interaction detail page
  // For sessions, navigate to session detail page
  const handleRowClick = () => {
    if (isSingleInteraction) {
      router.push(`/logs/${session.interactionId}`);
    } else if (session.sessionId) {
      router.push(`/logs/llm-proxy/session/${session.sessionId}`);
    }
  };

  // Check if this is an Archestra Chat session (has conversation title)
  const conversationTitle = session.conversationTitle;
  const isArchestraChat = conversationTitle && session.sessionId;

  // Check if this is a Claude Code session
  const claudeCodeTitle = session.claudeCodeTitle;
  const isClaudeCodeSession = session.sessionSource === "claude_code";

  // Get display text: prefer title, fallback to last user message
  const displayText = claudeCodeTitle || lastUserMessage;

  return (
    <TableRow className="cursor-pointer" onClick={handleRowClick}>
      <TableCell className="py-3 text-xs">
        <div className="flex items-center gap-1">
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
                className="flex-shrink-0"
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
                className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300 flex-shrink-0"
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
          ) : (
            <span className="text-muted-foreground">No message</span>
          )}
        </div>
      </TableCell>
      <TableCell className="font-mono text-xs py-3">
        {session.requestCount.toLocaleString()}
      </TableCell>
      <TableCell className="py-3">
        <div className="flex flex-wrap gap-1">
          {session.models.map((model) => (
            <Badge
              key={model}
              variant="secondary"
              className="text-xs whitespace-nowrap"
            >
              {model}
            </Badge>
          ))}
        </div>
      </TableCell>
      <TableCell className="font-mono text-xs py-3">
        {session.totalCost && session.totalBaselineCost && (
          <TooltipProvider>
            <Savings
              cost={session.totalCost}
              baselineCost={session.totalBaselineCost}
              toonCostSavings={session.totalToonCostSavings}
              format="percent"
              tooltip="hover"
              variant="session"
            />
          </TooltipProvider>
        )}
      </TableCell>
      <TableCell className="font-mono text-xs py-3">
        <div className="flex flex-col gap-0.5">
          {session.lastRequestTime && (
            <span>{formatDate({ date: String(session.lastRequestTime) })}</span>
          )}
          {session.requestCount > 1 &&
            session.firstRequestTime &&
            session.lastRequestTime && (
              <span className="text-muted-foreground">
                {formatDuration(
                  session.firstRequestTime,
                  session.lastRequestTime,
                )}
              </span>
            )}
        </div>
      </TableCell>
      <TableCell className="py-3">
        <div className="flex flex-wrap gap-1">
          <Badge variant="secondary" className="text-xs">
            <Layers className="h-3 w-3 mr-1" />
            {agent?.name ?? session.profileName ?? "Unknown"}
          </Badge>
          {session.userNames.map((userName) => (
            <Badge key={userName} variant="outline" className="text-xs">
              <User className="h-3 w-3 mr-1" />
              {userName}
            </Badge>
          ))}
        </div>
      </TableCell>
    </TableRow>
  );
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
      <span id="chunk-test" style={{ visibility: "hidden" }}>
        {" "}
      </span>
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
  const startDateFromUrl = searchParams.get("startDate");
  const endDateFromUrl = searchParams.get("endDate");
  const searchFromUrl = searchParams.get("search");

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || DEFAULT_TABLE_LIMIT);

  const [profileFilter, setProfileFilter] = useState(profileIdFromUrl || "all");
  const [userFilter, setUserFilter] = useState(userIdFromUrl || "all");
  const [searchFilter, setSearchFilter] = useState(searchFromUrl || "");

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

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchFilter(value);
      updateUrlParams({
        search: value || null,
        page: "1", // Reset to first page
      });
    },
    [updateUrlParams],
  );

  const { data: sessionsResponse } = useInteractionSessions({
    limit: pageSize,
    offset: pageIndex * pageSize,
    profileId: profileFilter !== "all" ? profileFilter : undefined,
    userId: userFilter !== "all" ? userFilter : undefined,
    startDate: dateTimePicker.startDateParam,
    endDate: dateTimePicker.endDateParam,
    search: searchFilter || undefined,
  });

  const { data: agents } = useProfiles({
    initialData: initialData?.agents,
  });

  const { data: uniqueUsers } = useUniqueUserIds();

  const sessions = sessionsResponse?.data ?? [];
  const paginationMeta = sessionsResponse?.pagination;

  const hasFilters =
    profileFilter !== "all" ||
    userFilter !== "all" ||
    dateTimePicker.dateRange !== undefined ||
    searchFilter !== "";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4">
        <div className="relative w-[250px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <DebouncedInput
            initialValue={searchFromUrl || ""}
            onChange={handleSearchChange}
            placeholder="Search sessions..."
            className="pl-9"
            debounceMs={400}
          />
        </div>

        <SearchableSelect
          value={profileFilter}
          onValueChange={handleProfileFilterChange}
          placeholder="Filter by Profile"
          items={[
            { value: "all", label: "All Profiles" },
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

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              handleSearchChange("");
              handleProfileFilterChange("all");
              handleUserFilterChange("all");
              dateTimePicker.clearDateRange();
            }}
          >
            Clear all filters
          </Button>
        )}
      </div>

      {!sessions || sessions.length === 0 ? (
        <p className="text-muted-foreground">
          {hasFilters
            ? "No sessions match your filters. Try adjusting your search."
            : "No sessions found"}
        </p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[200px]">Session</TableHead>
                <TableHead className="w-[100px] whitespace-nowrap">
                  Requests
                </TableHead>
                <TableHead className="w-[200px]">Models</TableHead>
                <TableHead className="w-[140px] whitespace-nowrap">
                  Cost
                </TableHead>
                <TableHead className="w-[160px]">Time</TableHead>
                <TableHead className="min-w-[100px]">Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session, index) => (
                <SessionRow
                  key={`${session.sessionId ?? "single"}-${session.profileId}-${index}`}
                  session={session}
                  agents={agents}
                />
              ))}
            </TableBody>
          </Table>
          {paginationMeta && (
            <Pagination
              pageIndex={pageIndex}
              pageSize={pageSize}
              total={paginationMeta.total}
              onPaginationChange={handlePaginationChange}
            />
          )}
        </div>
      )}
    </div>
  );
}
