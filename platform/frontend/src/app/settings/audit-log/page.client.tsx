"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { RefreshCw, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { LoadingWrapper } from "@/components/loading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useHasPermissions } from "@/lib/auth/auth.query";
import {
  type AuditLogEntry,
  useAuditLogs,
} from "@/lib/audit-log.query";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { cn } from "@/lib/utils";

const ACTION_BADGE_VARIANTS: Record<string, string> = {
  created: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  updated: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  deleted: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  invited: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400",
  removed: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400",
  login: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-400",
  logout: "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300",
};

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  agent: "Agent",
  member: "Member",
  team: "Team",
  organization: "Organization",
  api_key: "API Key",
  llm_provider: "LLM Provider",
  mcp_server: "MCP Server",
  knowledge_base: "Knowledge Base",
  role: "Role",
  auth: "Auth",
  secret: "Secret",
  invitation: "Invitation",
  tool_policy: "Tool Policy",
  identity_provider: "Identity Provider",
};

export default function AuditLogPage() {
  return (
    <ErrorBoundary>
      <AuditLogPageContent />
    </ErrorBoundary>
  );
}

function AuditLogPageContent() {
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const [resourceTypeFilter, setResourceTypeFilter] = useState<string>("");
  const [actionFilter, setActionFilter] = useState<string>("");

  const pageIndex = Number(searchParams.get("page") ?? "0");
  const offset = pageIndex * DEFAULT_TABLE_LIMIT;

  const { data: canViewAuditLog, isPending: isCheckingPermissions } =
    useHasPermissions({ organizationSettings: ["read"] });

  const {
    data,
    isPending,
    refetch,
    isRefetching,
  } = useAuditLogs({
    limit: DEFAULT_TABLE_LIMIT,
    offset,
    resourceType: resourceTypeFilter || undefined,
    action: actionFilter || undefined,
  });

  const columns: ColumnDef<AuditLogEntry>[] = useMemo(
    () => [
      {
        accessorKey: "createdAt",
        header: "Time",
        cell: ({ row }) => {
          const date = new Date(row.original.createdAt);
          return (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="text-muted-foreground text-sm cursor-default">
                    {formatDistanceToNow(date, { addSuffix: true })}
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{date.toLocaleString()}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        },
      },
      {
        id: "actor",
        header: "Actor",
        cell: ({ row }) => {
          const { actorName, actorEmail } = row.original;
          if (!actorName && !actorEmail) {
            return <span className="text-muted-foreground text-sm">System</span>;
          }
          return (
            <div className="flex flex-col">
              {actorName && (
                <span className="font-medium text-sm">{actorName}</span>
              )}
              {actorEmail && (
                <span className="text-muted-foreground text-xs">{actorEmail}</span>
              )}
            </div>
          );
        },
      },
      {
        accessorKey: "action",
        header: "Action",
        cell: ({ row }) => {
          const action = row.original.action;
          const variant = ACTION_BADGE_VARIANTS[action];
          return (
            <span
              className={cn(
                "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ring-transparent",
                variant ?? "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300",
              )}
            >
              {action}
            </span>
          );
        },
      },
      {
        accessorKey: "resourceType",
        header: "Resource",
        cell: ({ row }) => {
          const { resourceType, resourceLabel, resourceId } = row.original;
          const label = RESOURCE_TYPE_LABELS[resourceType] ?? resourceType;
          return (
            <div className="flex flex-col">
              <Badge variant="outline" className="w-fit text-xs">
                {label}
              </Badge>
              {resourceLabel && (
                <span className="text-sm mt-0.5">{resourceLabel}</span>
              )}
              {!resourceLabel && resourceId && (
                <span className="text-muted-foreground text-xs font-mono mt-0.5">
                  {resourceId.slice(0, 8)}…
                </span>
              )}
            </div>
          );
        },
      },
      {
        accessorKey: "ipAddress",
        header: "IP Address",
        cell: ({ row }) =>
          row.original.ipAddress ? (
            <code className="text-xs font-mono text-muted-foreground">
              {row.original.ipAddress}
            </code>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          ),
      },
    ],
    [],
  );

  if (isCheckingPermissions) {
    return <LoadingWrapper />;
  }

  if (!canViewAuditLog) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-12 text-center">
        <ShieldAlert className="h-10 w-10 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          You do not have permission to view the audit log.
        </p>
      </div>
    );
  }

  const total = data?.pagination?.total ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Select
            value={resourceTypeFilter}
            onValueChange={(v) => {
              setResourceTypeFilter(v);
              updateQueryParams({ page: "0" });
            }}
          >
            <SelectTrigger className="w-44 h-8 text-sm">
              <SelectValue placeholder="All resources" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">All resources</SelectItem>
              {Object.entries(RESOURCE_TYPE_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={actionFilter}
            onValueChange={(v) => {
              setActionFilter(v);
              updateQueryParams({ page: "0" });
            }}
          >
            <SelectTrigger className="w-36 h-8 text-sm">
              <SelectValue placeholder="All actions" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">All actions</SelectItem>
              {Object.keys(ACTION_BADGE_VARIANTS).map((action) => (
                <SelectItem key={action} value={action}>
                  {action}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isRefetching}
        >
          <RefreshCw
            className={cn("mr-2 h-3.5 w-3.5", isRefetching && "animate-spin")}
          />
          Refresh
        </Button>
      </div>

      <LoadingWrapper isPending={isPending}>
        <DataTable
          columns={columns}
          data={data?.data ?? []}
          emptyMessage="No audit log entries found."
          manualPagination
          pagination={{
            pageIndex,
            pageSize: DEFAULT_TABLE_LIMIT,
            total,
          }}
          onPaginationChange={({ pageIndex: newPageIndex }) =>
            updateQueryParams({ page: String(newPageIndex) })
          }
        />
      </LoadingWrapper>
    </div>
  );
}
