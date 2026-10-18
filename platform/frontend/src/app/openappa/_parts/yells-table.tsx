"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
  Activity,
  Check,
  Download,
  Megaphone,
  MessageCircle,
  RotateCcw,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CreatedByCell } from "@/components/created-by-cell";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { DataTable } from "@/components/ui/data-table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { setPendingChatHandoffFiles } from "@/lib/chat/pending-chat-handoff-files";
import { useCursorPagination } from "@/lib/hooks/use-cursor-pagination";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useIsMobile } from "@/lib/hooks/use-mobile";
import { llmSessionHref } from "@/lib/interactions/llm-log-links";
import {
  type OpenAppaYell,
  useOpenAppaYellArchive,
  useOpenAppaYells,
  useResolveOpenAppaYell,
} from "@/lib/openappa-yells.query";
import { formatDate, formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { useYellInvestigation } from "./use-yell-investigation";

export function YellsTable() {
  const [search, setSearch] = useState("");
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const status =
    searchParams.get("status") === "resolved" ? "resolved" : "unresolved";
  const pagination = useCursorPagination();
  const isMobile = useIsMobile();
  const { data: canRead, isPending: permissionsLoading } = useHasPermissions({
    log: ["read"],
  });
  const { data: canResolve } = useHasPermissions({
    log: ["read"],
  });
  const yells = useOpenAppaYells(
    {
      search: search || undefined,
      status,
      cursor: pagination.cursor,
      limit: pagination.pageSize,
    },
    !!canRead,
  );
  const resolve = useResolveOpenAppaYell();
  const clearFilters = () => {
    setSearch("");
    updateQueryParams({ status: null });
    pagination.goNewest();
  };
  const columns: ColumnDef<OpenAppaYell>[] = [
    {
      accessorKey: "message",
      header: "Report",
      size: isMobile ? 120 : 240,
      cell: ({ row }) => (
        <div className="min-w-0 space-y-1">
          <div className="flex items-start gap-2">
            {row.original.superyell && <BrokeTheGlassMark />}
            <p className="min-w-0 whitespace-pre-wrap break-words text-sm leading-relaxed">
              {row.original.message}
            </p>
          </div>
          {isMobile && (
            <span className="block space-y-1 text-xs font-normal text-muted-foreground">
              <YellCaller yell={row.original} />
              <span className="block">
                {formatRelativeTimeFromNow(row.original.createdAt)}
              </span>
            </span>
          )}
        </div>
      ),
    },
    {
      accessorKey: "caller",
      header: "Reported by",
      size: 280,
      cell: ({ row }) => <YellCaller yell={row.original} />,
    },
    {
      accessorKey: "createdAt",
      header: "Reported",
      size: 150,
      cell: ({ row }) => (
        <span
          className="whitespace-nowrap text-muted-foreground"
          title={formatDate({ date: row.original.createdAt })}
        >
          {formatRelativeTimeFromNow(row.original.createdAt)}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      size: 96,
      cell: ({ row }) => (
        <YellRowActions
          yell={row.original}
          canResolve={!!canResolve}
          pending={resolve.isPending}
          onResolve={() =>
            resolve.mutate({
              id: row.original.id,
              resolved: !row.original.resolvedAt,
            })
          }
        />
      ),
    },
  ];
  if (!permissionsLoading && !canRead)
    return (
      <p className="text-sm text-muted-foreground">
        You do not have permission to view yells.
      </p>
    );
  return (
    <div className="space-y-4">
      <CollectionFilters>
        <FilterBar
          search={
            <SearchInput
              value={search}
              syncQueryParams={false}
              placeholder="Search reports"
              className={filterSearchClass}
              isLoading={yells.isFetching}
              onSearchChange={(value) => {
                setSearch(value);
                pagination.goNewest();
              }}
            />
          }
          onClearFilters={
            search || status === "resolved" ? clearFilters : undefined
          }
        >
          <FilterSelect
            value={status}
            inactiveValue="unresolved"
            ariaLabel="Yell status"
            placeholder="Status"
            showSearch={false}
            items={[
              { value: "unresolved", label: "Unresolved" },
              { value: "resolved", label: "Resolved" },
            ]}
            onValueChange={(value) => {
              updateQueryParams({
                status: value === "resolved" ? value : null,
              });
              pagination.goNewest();
            }}
          />
        </FilterBar>
      </CollectionFilters>
      {yells.isError ? (
        <QueryLoadError
          title="Could not load yells"
          error={yells.error}
          onRetry={() => yells.refetch()}
        />
      ) : (
        <DataTable
          columns={
            isMobile
              ? columns.filter(
                  (column) =>
                    !(
                      "accessorKey" in column &&
                      (column.accessorKey === "createdAt" ||
                        column.accessorKey === "caller")
                    ),
                )
              : columns
          }
          fixedWidthColumnIds={["caller", "createdAt"]}
          flexibleColumnIds={["message"]}
          data={yells.data?.data ?? []}
          getRowId={(row) => row.id}
          isLoading={permissionsLoading || yells.isFetching}
          manualPagination
          cursorPagination={{
            pageIndex: pagination.pageIndex,
            pageSize: pagination.pageSize,
            canGoNewer: pagination.canGoNewer,
            hasNext: yells.data?.pagination.hasNext ?? false,
            onPageSizeChange: pagination.setPageSize,
            onNewer: pagination.goNewer,
            onOlder: () =>
              pagination.goOlder(yells.data?.pagination.nextCursor ?? null),
          }}
          emptyIcon={Megaphone}
          emptyMessage="No unresolved yells"
          emptyDescription="Reports appear here when an agent uses the yell tool."
          hasActiveFilters={!!search || status === "resolved"}
          filteredEmptyMessage="No reports match these filters."
          onClearFilters={clearFilters}
        />
      )}
    </div>
  );
}

function YellRowActions({
  yell,
  canResolve,
  pending,
  onResolve,
}: {
  yell: OpenAppaYell;
  canResolve: boolean;
  pending: boolean;
  onResolve: () => void;
}) {
  const investigation = useYellInvestigation({
    id: yell.id,
    hasArchive: yell.hasArchive,
    conversationId: yell.conversation?.id ?? null,
  });
  const archive = useOpenAppaYellArchive();
  const traceHref = useYellTraceHref(yell);
  return (
    <TableRowActions
      actions={[
        {
          icon: <MessageCircle className="size-4" />,
          label: investigation.label,
          permissions: investigation.permissions,
          disabled: investigation.disabled,
          onClick: investigation.launch,
        },
      ]}
      dropdownActions={[
        ...(traceHref
          ? [
              {
                icon: <Activity className="size-4" />,
                label: "View trace",
                href: traceHref,
              },
            ]
          : []),
        ...(canResolve
          ? [
              {
                icon: yell.resolvedAt ? (
                  <RotateCcw className="size-4" />
                ) : (
                  <Check className="size-4" />
                ),
                label: yell.resolvedAt ? "Reopen" : "Mark resolved",
                disabled: pending,
                onClick: onResolve,
              },
            ]
          : []),
        ...(yell.hasArchive
          ? [
              {
                icon: <Download className="size-4" />,
                label: "Download report",
                disabled: archive.isPending,
                onClick: () => archive.mutate({ id: yell.id, download: true }),
              },
            ]
          : []),
      ]}
    />
  );
}

/**
 * The yell's session trace, opened on its `yell` call. Only for a session
 * whose requests were logged, and that the viewer may read: their own, or
 * anyone's with `log:admin`.
 */
function useYellTraceHref(yell: OpenAppaYell): string | null {
  const { data: session } = useSession();
  const { data: canReadAllLogs } = useHasPermissions({ log: ["admin"] });
  const { trace } = yell;
  if (!trace) return null;
  const own = session?.user.id && yell.callerId === `user:${session.user.id}`;
  if (!own && !canReadAllLogs) return null;
  return llmSessionHref(
    trace.llmSessionId,
    trace.mcpToolCallId ? { toolCall: trace.mcpToolCallId } : undefined,
  );
}

function YellCaller({ yell }: { yell: OpenAppaYell }) {
  if (yell.caller)
    return (
      <CreatedByCell createdBy={yell.caller} showServiceAccountBadge={false} />
    );
  const label = yell.callerId.startsWith("user:service-account:")
    ? "Unknown service account"
    : yell.callerId.startsWith("user:")
      ? "Unknown user"
      : yell.callerId.startsWith("app:")
        ? "App"
        : yell.callerId.startsWith("virtual-key:")
          ? "Virtual key"
          : "Unattributed caller";
  return <span className="text-xs text-muted-foreground">{label}</span>;
}

/** Marks a yell sent with break the glass on, which also turned guardrails off. */
function BrokeTheGlassMark() {
  const label = "Broke the glass: guardrails turned off for this session";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          aria-label={label}
          className="mt-1 shrink-0 text-amber-600 dark:text-amber-400"
        >
          <Megaphone className="size-3.5" />
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
