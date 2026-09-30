"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Megaphone, MessageCircle } from "lucide-react";
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
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useCursorPagination } from "@/lib/hooks/use-cursor-pagination";
import {
  type OpenAppaYell,
  useOpenAppaYells,
  useResolveOpenAppaYell,
} from "@/lib/openappa-yells.query";
import { OpenAppaChatButton } from "./openappa-chat-button";

export function YellsTable() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"unresolved" | "resolved" | "all">(
    "unresolved",
  );
  const [selected, setSelected] = useState<OpenAppaYell | null>(null);
  const pagination = useCursorPagination();
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
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          className="h-auto max-w-lg justify-start whitespace-normal text-left"
          onClick={() => setSelected(row.original)}
        >
          <span className="line-clamp-2">{row.original.message}</span>
        </Button>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => (
        <Badge variant="outline">
          {row.original.resolvedAt ? "Resolved" : "Unresolved"}
        </Badge>
      ),
    },
    {
      accessorKey: "createdAt",
      header: "Reported",
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-muted-foreground">
          {new Date(row.original.createdAt).toLocaleString()}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => <YellChatAction id={row.original.id} />,
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
      <div>
        <h2 className="text-lg font-semibold">Yells</h2>
        <p className="text-sm text-muted-foreground">
          Investigate reported blocks and remedies, then mark them resolved when
          the issue is fixed.
        </p>
      </div>
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
          columns={columns}
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
          description={`Reported ${new Date(selected.createdAt).toLocaleString()}`}
          footer={
            <>
              <YellChatAction id={selected.id} />
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
                  {selected.resolvedAt ? "Reopen" : "Mark resolved"}
                </Button>
              )}
            </>
          }
        >
          <div className="space-y-4">
            <Badge variant="outline">
              {selected.resolvedAt ? "Resolved" : "Unresolved"}
            </Badge>
            <p className="whitespace-pre-wrap break-words text-sm">
              {selected.message}
            </p>
            <p className="text-xs text-muted-foreground">
              {selected.reportFailed
                ? "Saved here. External reporting failed."
                : selected.reportedAt
                  ? "Also sent to the OpenAPPA reporting service."
                  : "External delivery has not been confirmed."}
            </p>
          </div>
        </StandardDialog>
      )}
    </div>
  );
}

function YellChatAction({ id }: { id: string }) {
  return (
    <OpenAppaChatButton
      promptKey="explainPolicy"
      yellId={id}
      variant="outline"
      size="sm"
    >
      <MessageCircle />
      Investigate in chat
    </OpenAppaChatButton>
  );
}
