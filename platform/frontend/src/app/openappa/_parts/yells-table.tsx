"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
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
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { setPendingChatHandoffFiles } from "@/lib/chat/pending-chat-handoff-files";
import { useCursorPagination } from "@/lib/hooks/use-cursor-pagination";
import { useIsMobile } from "@/lib/hooks/use-mobile";
import {
  type OpenAppaYell,
  useOpenAppaYellArchive,
  useOpenAppaYells,
  useResolveOpenAppaYell,
} from "@/lib/openappa-yells.query";
import { formatDate, formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { useOpenAppaChatLaunch } from "./openappa-chat-button";

export function YellsTable() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"unresolved" | "resolved" | "all">(
    "all",
  );
  const pagination = useCursorPagination();
  const isMobile = useIsMobile();
  const { data: canRead, isPending: permissionsLoading } = useHasPermissions({
    log: ["read"],
  });
  const { data: canResolve } = useHasPermissions({
    log: ["read"],
    toolPolicy: ["update"],
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
    setStatus("all");
    pagination.goNewest();
  };
  const columns: ColumnDef<OpenAppaYell>[] = [
    {
      accessorKey: "message",
      header: "Report",
      size: isMobile ? 120 : 240,
      cell: ({ row }) => (
        <div className="min-w-0 space-y-1">
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {row.original.message}
          </p>
          {isMobile && (
            <span className="block space-y-1 text-xs font-normal text-muted-foreground">
              <YellCaller yell={row.original} />
              <span className="block">
                {row.original.resolvedAt ? "Resolved" : "Unresolved"} ·{" "}
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
      id: "status",
      header: "Status",
      size: 110,
      cell: ({ row }) => (
        <Badge variant="outline">
          {row.original.resolvedAt ? "Resolved" : "Unresolved"}
        </Badge>
      ),
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
      size: canResolve ? 112 : 72,
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
          onClearFilters={search || status !== "all" ? clearFilters : undefined}
        >
          <FilterSelect
            value={status}
            inactiveValue="all"
            ariaLabel="Yell status"
            placeholder="Status"
            showSearch={false}
            items={[
              { value: "all", label: "All statuses" },
              { value: "unresolved", label: "Unresolved" },
              { value: "resolved", label: "Resolved" },
            ]}
            onValueChange={(value) => {
              if (
                value === "unresolved" ||
                value === "resolved" ||
                value === "all"
              ) {
                setStatus(value);
                pagination.goNewest();
              }
            }}
          />
        </FilterBar>
      </CollectionFilters>
      {yells.isError ? (
        <QueryLoadError
          title="Could not load yells"
          onRetry={() => yells.refetch()}
        />
      ) : (
        <DataTable
          columns={
            isMobile
              ? columns.filter(
                  (column) =>
                    column.id !== "status" &&
                    !(
                      "accessorKey" in column &&
                      (column.accessorKey === "createdAt" ||
                        column.accessorKey === "caller")
                    ),
                )
              : columns
          }
          fixedWidthColumnIds={["caller", "status", "createdAt"]}
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
          emptyMessage={
            status === "unresolved"
              ? "No unresolved yells"
              : status === "resolved"
                ? "No resolved yells"
                : "No yells yet"
          }
          emptyDescription="Reports appear here when an agent uses the yell tool."
          hasActiveFilters={!!search || status !== "all"}
          filteredEmptyMessage="No reports match these filters."
          onClearFilters={clearFilters}
        />
      )}
    </div>
  );
}

function useYellInvestigation(yell: OpenAppaYell) {
  const router = useRouter();
  const { href, agents } = useOpenAppaChatLaunch({
    promptKey: "explainPolicy",
    yellId: yell.id,
  });
  const archive = useOpenAppaYellArchive();
  return {
    disabled: archive.isPending || (!href && !agents.isError),
    launch: () => {
      if (!href) {
        void agents.refetch();
        return;
      }
      if (!yell.hasArchive) {
        router.push(href);
        return;
      }
      archive.mutate(
        { id: yell.id },
        {
          onSuccess: (file) => {
            if (!file) return;
            setPendingChatHandoffFiles([file]);
            router.push(`${href}&attachments=1`);
          },
        },
      );
    },
  };
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
  const investigation = useYellInvestigation(yell);
  const archive = useOpenAppaYellArchive();
  return (
    <TableRowActions
      actions={[
        {
          icon: <MessageCircle className="size-4" />,
          label: "Investigate in chat",
          disabled: investigation.disabled,
          onClick: investigation.launch,
        },
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
