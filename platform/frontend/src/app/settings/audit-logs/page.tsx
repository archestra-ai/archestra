"use client";

import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { ChevronDown, ChevronUp, User } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { SearchInput } from "@/components/search-input";
import { TableFilters } from "@/components/table-filters";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DateTimeRangePicker } from "@/components/ui/date-time-range-picker";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import {
  type AuditLogEntry,
  useAuditLogs,
} from "@/lib/audit-log/audit-log.query";
import { useDateTimeRangePicker } from "@/lib/hooks/use-date-time-range-picker";
import { formatDate } from "@/lib/utils";
import { ErrorBoundary } from "../../_parts/error-boundary";

const ACTION_DISPLAY_LABELS: Record<string, string> = {
  "user.invited": "Invited User",
  "user.deleted": "Deleted User",
  "user.role_changed": "Changed User Role",
  "role.created": "Created Role",
  "role.updated": "Updated Role",
  "role.deleted": "Deleted Role",
  "api_key.created": "Created API Key",
  "api_key.deleted": "Deleted API Key",
  "org.settings_updated": "Settings Updated",
  "team.created": "Created Team",
  "team.updated": "Updated Team",
  "team.deleted": "Deleted Team",
  "team.membership_changed": "Changed Team Membership",
  "idp.created": "Created IdP",
  "idp.updated": "Updated IdP",
  "idp.deleted": "Deleted IdP",
  "secret.updated": "Secret Updated",
  "audit_log.retention_cleared": "Cleared Audit Log",
};

function formatAction(action: string): string {
  return (
    ACTION_DISPLAY_LABELS[action] ||
    action.replace(/_/g, " ").replace(/\./g, " → ")
  );
}

function SortIcon({ isSorted }: { isSorted: false | "asc" | "desc" }) {
  const upArrow = <ChevronUp className="h-3 w-3" />;
  const downArrow = <ChevronDown className="h-3 w-3" />;
  if (isSorted === "asc") return upArrow;
  if (isSorted === "desc") return downArrow;
  return (
    <div className="text-muted-foreground/50 flex flex-col items-center">
      {upArrow}
      <span className="mt-[-4px]">{downArrow}</span>
    </div>
  );
}

export default function AuditLogsPage() {
  return (
    <ErrorBoundary>
      <AuditLogsTable />
    </ErrorBoundary>
  );
}

function AuditLogsTable() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  const startDateFromUrl = searchParams.get("startDate");
  const endDateFromUrl = searchParams.get("endDate");
  const searchFromUrl = searchParams.get("search");
  const actionFromUrl = searchParams.get("action");

  const [pagination, setPagination] = useState({
    pageIndex: 0,
    pageSize: DEFAULT_TABLE_LIMIT,
  });
  const [sorting, setSorting] = useState<SortingState>([
    { id: "createdAt", desc: true },
  ]);

  const updateUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const dateTimePicker = useDateTimeRangePicker({
    startDateFromUrl,
    endDateFromUrl,
    onDateRangeChange: useCallback(
      ({ startDate, endDate }) => {
        setPagination((prev) => ({ ...prev, pageIndex: 0 }));
        updateUrlParams({
          startDate: startDate ?? null,
          endDate: endDate ?? null,
        });
      },
      [updateUrlParams],
    ),
  });

  const sortBy = sorting[0]?.id as
    | "createdAt"
    | "action"
    | "resource"
    | undefined;
  const sortDirection = sorting[0]?.desc ? "desc" : "asc";

  const { data: auditLogResponse, isFetching } = useAuditLogs({
    action: actionFromUrl || undefined,
    limit: pagination.pageSize,
    offset: pagination.pageIndex * pagination.pageSize,
    sortBy,
    sortDirection,
    startDate: dateTimePicker.startDateParam,
    endDate: dateTimePicker.endDateParam,
    search: searchFromUrl || undefined,
  });

  const auditLogs = auditLogResponse?.data ?? [];
  const paginationMeta = auditLogResponse?.pagination;

  const columns: ColumnDef<AuditLogEntry>[] = useMemo(
    () => [
      {
        id: "createdAt",
        header: ({ column }) => (
          <Button
            variant="ghost"
            className="h-auto !p-0 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Date
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        ),
        cell: ({ row }) => (
          <div className="font-mono text-xs whitespace-nowrap">
            {formatDate({ date: row.original.createdAt })}
          </div>
        ),
      },
      {
        id: "action",
        header: ({ column }) => (
          <Button
            variant="ghost"
            className="h-auto !p-0 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Action
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        ),
        cell: ({ row }) => {
          const action = row.original.action;
          return (
            <Badge variant="secondary" className="text-xs whitespace-nowrap">
              {formatAction(action)}
            </Badge>
          );
        },
      },
      {
        id: "resource",
        header: "Resource",
        cell: ({ row }) => (
          <div className="text-xs">
            <span className="font-medium">{row.original.resource}</span>
            {row.original.resourceId && (
              <span className="text-muted-foreground ml-1">
                #{row.original.resourceId.slice(0, 8)}
              </span>
            )}
          </div>
        ),
      },
      {
        id: "user",
        header: "User",
        cell: ({ row }) => {
          const { userName, userEmail } = row.original;
          if (!userName && !userEmail) {
            return <div className="text-xs text-muted-foreground">—</div>;
          }
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-1.5 max-w-[180px]">
                  <User className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="text-xs truncate">
                    {userName || userEmail}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent>
                {userName && <p>{userName}</p>}
                {userEmail && (
                  <p className="text-xs text-muted-foreground">{userEmail}</p>
                )}
              </TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        id: "ip",
        header: "IP",
        cell: ({ row }) => {
          const ip = row.original.metadata?.ip;
          return (
            <div className="font-mono text-xs text-muted-foreground">
              {ip || "—"}
            </div>
          );
        },
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <TableFilters>
        <SearchInput
          placeholder="Search actions, resources..."
          value={searchFromUrl || ""}
          onSearchChange={(value) => {
            setPagination((prev) => ({ ...prev, pageIndex: 0 }));
            updateUrlParams({ search: value || null });
          }}
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
        data={auditLogs}
        pagination={{
          pageIndex: pagination.pageIndex,
          pageSize: pagination.pageSize,
          total: paginationMeta?.total ?? 0,
        }}
        onPaginationChange={(newPagination) => {
          if (newPagination.pageSize !== pagination.pageSize) {
            setPagination({ pageIndex: 0, pageSize: newPagination.pageSize });
          } else {
            setPagination((prev) => ({
              ...prev,
              pageIndex: newPagination.pageIndex,
            }));
          }
        }}
        manualPagination
        sorting={sorting}
        onSortingChange={setSorting}
        manualSorting
        isLoading={isFetching}
        emptyMessage="No audit log entries yet. Events will appear here as admin actions are performed."
      />
    </div>
  );
}
