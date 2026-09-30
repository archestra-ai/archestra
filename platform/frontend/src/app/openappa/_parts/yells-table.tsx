"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
  Check,
  Clock3,
  Megaphone,
  MessageCircle,
  RotateCcw,
  Send,
} from "lucide-react";
import { useState } from "react";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DialogDescription } from "@/components/ui/dialog";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useCursorPagination } from "@/lib/hooks/use-cursor-pagination";
import { useIsMobile } from "@/lib/hooks/use-mobile";
import {
  type OpenAppaYell,
  useOpenAppaYells,
  useResolveOpenAppaYell,
} from "@/lib/openappa-yells.query";
import { formatDate } from "@/lib/utils/date-time";
import { OpenAppaChatButton } from "./openappa-chat-button";

export function YellsTable() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"unresolved" | "resolved" | "all">(
    "unresolved",
  );
  const [selected, setSelected] = useState<OpenAppaYell | null>(null);
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
    setStatus("unresolved");
    pagination.goNewest();
  };
  const columns: ColumnDef<OpenAppaYell>[] = [
    {
      accessorKey: "message",
      header: "Report",
      size: isMobile ? 120 : 240,
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          className="-ml-1.5 h-auto w-full min-w-0 justify-start whitespace-normal px-1.5 text-left"
          onClick={() => setSelected(row.original)}
        >
          <span className="min-w-0 space-y-1">
            <span className="line-clamp-2 break-words">
              {row.original.message}
            </span>
            {isMobile && (
              <span className="block text-xs font-normal text-muted-foreground">
                {row.original.resolvedAt ? "Resolved" : "Unresolved"} ·{" "}
                {formatDate({
                  date: row.original.createdAt,
                  dateFormat: "MMM d",
                })}
              </span>
            )}
          </span>
        </Button>
      ),
    },
    {
      id: "status",
      header: "Status",
      size: 120,
      cell: ({ row }) => (
        <Badge variant="outline">
          {row.original.resolvedAt ? "Resolved" : "Unresolved"}
        </Badge>
      ),
    },
    {
      accessorKey: "createdAt",
      header: "Reported",
      size: 170,
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-muted-foreground">
          {formatDate({
            date: row.original.createdAt,
            dateFormat: "MMM d, yyyy · h:mm a",
          })}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      size: isMobile ? 144 : 208,
      cell: ({ row }) => (
        <YellChatAction id={row.original.id} compact={isMobile} />
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
            search || status !== "unresolved" ? clearFilters : undefined
          }
        >
          <FilterSelect
            value={status}
            ariaLabel="Yell status"
            placeholder="Status"
            showSearch={false}
            items={[
              { value: "unresolved", label: "Unresolved" },
              { value: "resolved", label: "Resolved" },
              { value: "all", label: "All statuses" },
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
                      column.accessorKey === "createdAt"
                    ),
                )
              : columns
          }
          fixedWidthColumnIds={["status", "createdAt"]}
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
          hasActiveFilters={!!search}
          filteredEmptyMessage="No reports match these filters."
          onClearFilters={() => {
            setSearch("");
            setStatus("all");
            pagination.goNewest();
          }}
        />
      )}
      {selected && (
        <StandardDialog
          open
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
          title="OpenAPPA yell"
          bodyClassName="space-y-4"
          footer={
            <>
              <YellChatAction id={selected.id} primary />
              {canResolve && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={resolve.isPending}
                  onClick={() =>
                    resolve.mutate(
                      { id: selected.id, resolved: !selected.resolvedAt },
                      {
                        onSuccess: (row) => {
                          if (row) setSelected(row);
                        },
                      },
                    )
                  }
                >
                  {selected.resolvedAt ? <RotateCcw /> : <Check />}
                  <span>
                    {selected.resolvedAt ? "Reopen" : "Mark resolved"}
                  </span>
                </Button>
              )}
            </>
          }
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <DialogDescription className="sr-only">
              Review the reported issue, investigate it in chat, or update its
              resolution status.
            </DialogDescription>
            <Badge variant="outline">
              {selected.resolvedAt ? "Resolved" : "Unresolved"}
            </Badge>
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock3 className="size-3.5" />
              {formatDate({
                date: selected.createdAt,
                dateFormat: "MMM d, yyyy · h:mm a",
              })}
            </span>
          </div>
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
              {selected.message}
            </p>
          </div>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Send className="size-3.5 shrink-0" />
            <span>
              {selected.reportFailed
                ? "External report failed. Your report is saved here."
                : selected.reportedAt
                  ? "Sent to OpenAPPA developers"
                  : "External report awaiting confirmation"}
            </span>
          </p>
        </StandardDialog>
      )}
    </div>
  );
}

function YellChatAction({
  id,
  compact = false,
  primary = false,
}: {
  id: string;
  compact?: boolean;
  primary?: boolean;
}) {
  return (
    <OpenAppaChatButton
      promptKey="explainPolicy"
      yellId={id}
      variant={primary ? "default" : "outline"}
      size="sm"
      aria-label="Investigate in chat"
    >
      {!compact && <MessageCircle />}
      <span>{compact ? "Investigate" : "Investigate in chat"}</span>
    </OpenAppaChatButton>
  );
}
