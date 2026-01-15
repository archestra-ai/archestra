"use client";

import type { archestraApiTypes } from "@shared";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { format } from "date-fns";
import { CalendarIcon, ChevronDown, ChevronUp, Clock, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import type { DateRange } from "react-day-picker";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useProfiles } from "@/lib/agent.query";
import { useMcpToolCalls } from "@/lib/mcp-tool-call.query";
import { cn, DEFAULT_TABLE_LIMIT, formatDate } from "@/lib/utils";
import { ErrorBoundary } from "../../_parts/error-boundary";

type McpToolCallData =
  archestraApiTypes.GetMcpToolCallsResponses["200"]["data"][number];

function SortIcon({ isSorted }: { isSorted: false | "asc" | "desc" }) {
  const upArrow = <ChevronUp className="h-3 w-3" />;
  const downArrow = <ChevronDown className="h-3 w-3" />;
  if (isSorted === "asc") {
    return upArrow;
  }
  if (isSorted === "desc") {
    return downArrow;
  }
  return (
    <div className="text-muted-foreground/50 flex flex-col items-center">
      {upArrow}
      <span className="mt-[-4px]">{downArrow}</span>
    </div>
  );
}

export default function McpGatewayLogsPage({
  initialData,
}: {
  initialData?: {
    mcpToolCalls: archestraApiTypes.GetMcpToolCallsResponses["200"];
    agents: archestraApiTypes.GetAllAgentsResponses["200"];
  };
}) {
  return (
    <div>
      <ErrorBoundary>
        <McpToolCallsTable initialData={initialData} />
      </ErrorBoundary>
    </div>
  );
}

function McpToolCallsTable({
  initialData,
}: {
  initialData?: {
    mcpToolCalls: archestraApiTypes.GetMcpToolCallsResponses["200"];
    agents: archestraApiTypes.GetAllAgentsResponses["200"];
  };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  // Get URL params for date range
  const startDateFromUrl = searchParams.get("startDate");
  const endDateFromUrl = searchParams.get("endDate");

  const [pagination, setPagination] = useState({
    pageIndex: 0,
    pageSize: DEFAULT_TABLE_LIMIT,
  });
  const [sorting, setSorting] = useState<SortingState>([
    { id: "createdAt", desc: true },
  ]);

  // Date range state
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => {
    if (startDateFromUrl && endDateFromUrl) {
      return {
        from: new Date(startDateFromUrl),
        to: new Date(endDateFromUrl),
      };
    }
    return undefined;
  });

  // Datetime picker dialog state
  const [isDateDialogOpen, setIsDateDialogOpen] = useState(false);
  const [tempDateRange, setTempDateRange] = useState<DateRange | undefined>(
    dateRange,
  );
  const [fromTime, setFromTime] = useState(() => {
    if (startDateFromUrl) {
      const date = new Date(startDateFromUrl);
      return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    }
    return "00:00";
  });
  const [toTime, setToTime] = useState(() => {
    if (endDateFromUrl) {
      const date = new Date(endDateFromUrl);
      return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    }
    return "23:59";
  });

  // Helper to update URL params
  const updateUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      Object.entries(updates).forEach(([key, value]) => {
        if (value === null || value === "") {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      });
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const openDateDialog = useCallback(() => {
    setTempDateRange(dateRange);
    if (dateRange?.from) {
      setFromTime(
        `${String(dateRange.from.getHours()).padStart(2, "0")}:${String(dateRange.from.getMinutes()).padStart(2, "0")}`,
      );
    } else {
      setFromTime("00:00");
    }
    if (dateRange?.to) {
      setToTime(
        `${String(dateRange.to.getHours()).padStart(2, "0")}:${String(dateRange.to.getMinutes()).padStart(2, "0")}`,
      );
    } else {
      setToTime("23:59");
    }
    setIsDateDialogOpen(true);
  }, [dateRange]);

  const handleApplyDateRange = useCallback(() => {
    if (!tempDateRange?.from || !tempDateRange?.to) {
      return;
    }

    const fromDateTime = new Date(tempDateRange.from);
    const toDateTime = new Date(tempDateRange.to);

    const [fromHours, fromMinutes] = fromTime.split(":").map(Number);
    fromDateTime.setHours(fromHours, fromMinutes, 0, 0);

    const [toHours, toMinutes] = toTime.split(":").map(Number);
    toDateTime.setHours(toHours, toMinutes, 59, 999);

    setDateRange({ from: fromDateTime, to: toDateTime });
    setPagination((prev) => ({ ...prev, pageIndex: 0 })); // Reset to first page
    updateUrlParams({
      startDate: fromDateTime.toISOString(),
      endDate: toDateTime.toISOString(),
    });
    setIsDateDialogOpen(false);
  }, [tempDateRange, fromTime, toTime, updateUrlParams]);

  const clearDateRange = useCallback(() => {
    setDateRange(undefined);
    setTempDateRange(undefined);
    setFromTime("00:00");
    setToTime("23:59");
    setPagination((prev) => ({ ...prev, pageIndex: 0 })); // Reset to first page
    updateUrlParams({
      startDate: null,
      endDate: null,
    });
  }, [updateUrlParams]);

  // Build date params for API call
  const startDateParam = dateRange?.from
    ? dateRange.from.toISOString()
    : undefined;
  const endDateParam = dateRange?.to ? dateRange.to.toISOString() : undefined;

  // Helper to format date range display
  const getDateRangeDisplay = useCallback(() => {
    if (!dateRange?.from || !dateRange?.to) {
      return null;
    }
    const hasCustomTime =
      dateRange.from.getHours() !== 0 ||
      dateRange.from.getMinutes() !== 0 ||
      dateRange.to.getHours() !== 23 ||
      dateRange.to.getMinutes() !== 59;

    if (hasCustomTime) {
      return `${format(dateRange.from, "LLL dd, HH:mm")} - ${format(dateRange.to, "LLL dd, HH:mm")}`;
    }
    return `${format(dateRange.from, "LLL dd, y")} - ${format(dateRange.to, "LLL dd, y")}`;
  }, [dateRange]);

  // Convert TanStack sorting to API format
  const sortBy = sorting[0]?.id;
  const sortDirection = sorting[0]?.desc ? "desc" : "asc";
  // Map UI column ids to API sort fields
  const apiSortBy: NonNullable<
    archestraApiTypes.GetMcpToolCallsData["query"]
  >["sortBy"] =
    sortBy === "agent"
      ? "agentId"
      : sortBy === "mcpServerName"
        ? "mcpServerName"
        : sortBy === "method"
          ? "method"
          : sortBy === "createdAt"
            ? "createdAt"
            : undefined;

  const { data: mcpToolCallsResponse } = useMcpToolCalls({
    limit: pagination.pageSize,
    offset: pagination.pageIndex * pagination.pageSize,
    sortBy: apiSortBy,
    sortDirection,
    startDate: startDateParam,
    endDate: endDateParam,
    initialData: initialData?.mcpToolCalls,
  });

  const { data: agents } = useProfiles({
    initialData: initialData?.agents,
  });

  const mcpToolCalls = mcpToolCallsResponse?.data ?? [];
  const paginationMeta = mcpToolCallsResponse?.pagination;

  const columns: ColumnDef<McpToolCallData>[] = [
    {
      id: "createdAt",
      header: ({ column }) => {
        return (
          <Button
            variant="ghost"
            className="h-auto !p-0 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Date
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        );
      },
      cell: ({ row }) => (
        <div className="font-mono text-xs">
          {formatDate({
            date: row.original.createdAt,
          })}
        </div>
      ),
    },
    {
      id: "method",
      header: "Method",
      cell: ({ row }) => {
        const method = row.original.method || "tools/call";
        const variant =
          method === "initialize"
            ? "outline"
            : method === "tools/list"
              ? "secondary"
              : "default";
        return (
          <Badge variant={variant} className="text-xs whitespace-nowrap">
            {method}
          </Badge>
        );
      },
    },
    {
      id: "agent",
      accessorFn: (row) => {
        const agent = agents?.find((a) => a.id === row.agentId);
        return agent?.name ?? "Unknown";
      },
      header: ({ column }) => {
        return (
          <Button
            variant="ghost"
            className="h-auto !p-0 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Profile
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        );
      },
      cell: ({ row }) => {
        const agent = agents?.find((a) => a.id === row.original.agentId);
        return (
          <TruncatedText message={agent?.name ?? "Unknown"} maxLength={30} />
        );
      },
    },
    {
      id: "mcpServerName",
      header: ({ column }) => {
        return (
          <Button
            variant="ghost"
            className="h-auto !p-0 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            MCP Server
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        );
      },
      cell: ({ row }) => {
        return (
          <Badge variant="secondary" className="text-xs whitespace-normal">
            <TruncatedText
              message={row.original.mcpServerName}
              maxLength={15}
            />
          </Badge>
        );
      },
    },
    {
      id: "toolName",
      header: "Tool Name",
      cell: ({ row }) => {
        const toolName = row.original.toolCall?.name;
        if (!toolName) {
          return <div className="text-xs text-muted-foreground">—</div>;
        }
        return (
          <div className="text-xs">
            <TruncatedText message={toolName} maxLength={40} />
          </div>
        );
      },
    },
    {
      id: "arguments",
      header: "Arguments",
      cell: ({ row }) => {
        const args = row.original.toolCall?.arguments;
        if (!args) {
          return <div className="text-xs text-muted-foreground">—</div>;
        }
        const argsString = JSON.stringify(args);
        return (
          <div className="text-xs font-mono">
            <TruncatedText message={argsString} maxLength={60} />
          </div>
        );
      },
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => {
        const result = row.original.toolResult;
        const method = row.original.method || "tools/call";

        // For tools/call, check isError
        if (
          method === "tools/call" &&
          result &&
          typeof result === "object" &&
          "isError" in result
        ) {
          const isError = (result as { isError: boolean }).isError;
          return (
            <Badge
              variant={isError ? "destructive" : "default"}
              className="text-xs whitespace-nowrap"
            >
              {isError ? "Error" : "Success"}
            </Badge>
          );
        }

        // For other methods, just show success
        return (
          <Badge variant="default" className="text-xs whitespace-nowrap">
            Success
          </Badge>
        );
      },
    },
    {
      id: "result",
      header: "Result",
      cell: ({ row }) => {
        const result = row.original.toolResult;
        const method = row.original.method || "tools/call";

        // Handle tools/call with standard result structure
        if (
          method === "tools/call" &&
          result &&
          typeof result === "object" &&
          "isError" in result
        ) {
          const toolResult = result as {
            isError: boolean;
            error?: string;
            content?: unknown;
          };
          if (toolResult.isError) {
            return (
              <div className="text-xs text-destructive">
                <TruncatedText
                  message={toolResult.error || "Unknown error"}
                  maxLength={60}
                />
              </div>
            );
          }
          const contentString =
            typeof toolResult.content === "string"
              ? toolResult.content
              : JSON.stringify(toolResult.content);
          return (
            <div className="text-xs">
              <TruncatedText message={contentString} maxLength={60} />
            </div>
          );
        }

        // For other methods, just stringify the result
        const resultString =
          typeof result === "string" ? result : JSON.stringify(result);
        return (
          <div className="text-xs">
            <TruncatedText message={resultString} maxLength={60} />
          </div>
        );
      },
    },
  ];

  const hasFilters = dateRange !== undefined;

  // Shared date picker dialog
  const datePickerDialog = (
    <Dialog open={isDateDialogOpen} onOpenChange={setIsDateDialogOpen}>
      <DialogContent className="sm:max-w-[800px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Select Date and Time Range</DialogTitle>
          <DialogDescription>
            Choose a date range and optionally specify start and end times.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-6 py-4">
          <div className="space-y-3">
            <Label className="text-sm font-medium">Date Range</Label>
            <div className="flex justify-center">
              <Calendar
                mode="range"
                defaultMonth={tempDateRange?.from}
                selected={tempDateRange}
                onSelect={setTempDateRange}
                numberOfMonths={2}
                className="rounded-md border"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="from-time-mcp" className="text-sm font-medium">
                From Time
              </Label>
              <Input
                id="from-time-mcp"
                type="time"
                value={fromTime}
                onChange={(e) => setFromTime(e.target.value)}
                className="w-full"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="to-time-mcp" className="text-sm font-medium">
                To Time
              </Label>
              <Input
                id="to-time-mcp"
                type="time"
                value={toTime}
                onChange={(e) => setToTime(e.target.value)}
                className="w-full"
              />
            </div>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setIsDateDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleApplyDateRange}
            disabled={!tempDateRange?.from || !tempDateRange?.to}
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // Shared date picker button
  const datePickerButton = (
    <>
      <Button
        variant="outline"
        onClick={openDateDialog}
        className={cn(
          "w-[320px] justify-start text-left font-normal",
          !dateRange && "text-muted-foreground",
        )}
      >
        <CalendarIcon className="mr-2 h-4 w-4" />
        {getDateRangeDisplay() || <span>Pick a date and time range</span>}
      </Button>

      {dateRange && (
        <Button
          variant="outline"
          size="icon"
          onClick={openDateDialog}
          className="h-10 w-10"
        >
          <Clock className="h-4 w-4" />
        </Button>
      )}

      {dateRange && (
        <Button
          variant="ghost"
          size="icon"
          onClick={clearDateRange}
          className="h-10 w-10"
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </>
  );

  if (!mcpToolCalls || mcpToolCalls.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap gap-4">{datePickerButton}</div>

        {datePickerDialog}

        <div className="text-center py-12">
          <p className="text-muted-foreground text-sm">
            {hasFilters
              ? "No MCP tool calls match your filters. Try adjusting your date range."
              : "No MCP tool calls found. Tool calls will appear here when agents use MCP tools."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4">
        {datePickerButton}

        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={clearDateRange}>
            Clear filters
          </Button>
        )}
      </div>

      {datePickerDialog}

      <DataTable
        columns={columns}
        data={mcpToolCalls}
        pagination={
          paginationMeta
            ? {
                pageIndex: pagination.pageIndex,
                pageSize: pagination.pageSize,
                total: paginationMeta.total,
              }
            : undefined
        }
        manualPagination
        onPaginationChange={(newPagination) => {
          setPagination(newPagination);
        }}
        manualSorting
        sorting={sorting}
        onSortingChange={setSorting}
      />
    </div>
  );
}
