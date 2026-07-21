"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { Clock, ExternalLink, Eye, FileText, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AclBadges } from "@/app/knowledge/connectors/_parts/acl-badges";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { SearchInput } from "@/components/search-input";
import { StandardDialog } from "@/components/standard-dialog";
import { TableFilters } from "@/components/table-filters";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { DataTable } from "@/components/ui/data-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import { useConnectorUserGroups } from "@/lib/knowledge/connector.query";
import {
  type KnowledgeBaseDocumentListItem,
  useConnectorDocument,
  useConnectorDocuments,
  useDeleteConnectorDocument,
} from "@/lib/knowledge/kb-document.query";
import { formatDate } from "@/lib/utils";

type PaginationMeta =
  archestraApiTypes.GetConnectorDocumentsResponses["200"]["pagination"];

const DEFAULT_DOCUMENT_PAGE_SIZE = 10;
const MAX_PREVIEW_CHARS = 20_000;

export function ConnectorDocumentsTable({
  connectorId,
  showGroupFilter = false,
}: {
  connectorId: string;
  /** Auto-sync connectors only: filter documents by upstream group. */
  showGroupFilter?: boolean;
}) {
  const {
    searchParams,
    pageIndex,
    pageSize,
    offset,
    setPagination,
    updateQueryParams,
  } = useDataTableQueryParams({ defaultPageSize: DEFAULT_DOCUMENT_PAGE_SIZE });
  const search = searchParams.get("search") ?? "";
  const group = searchParams.get("group") ?? "";
  // The group snapshot is known ahead of time, so the filter can offer
  // every group that exists on the connector.
  const { data: userGroups } = useConnectorUserGroups({
    connectorId,
    enabled: showGroupFilter,
  });
  const groupIds = useMemo(
    () => [...new Set((userGroups?.groups ?? []).map((g) => g.groupId))].sort(),
    [userGroups?.groups],
  );

  const documentIdFromUrl = searchParams.get("document");
  const { data: documentFromUrl } = useConnectorDocument({
    path: { id: connectorId, docId: documentIdFromUrl ?? "" },
    enabled: documentIdFromUrl !== null,
  });
  const {
    entity: selectedPreviewDoc,
    open: openPreviewDialog,
    close: closePreviewDialog,
  } = useDialogUrlParam<KnowledgeBaseDocumentListItem>({
    paramName: "document",
    entityFromUrl: documentFromUrl ?? null,
  });
  const [deletingDoc, setDeletingDoc] =
    useState<KnowledgeBaseDocumentListItem | null>(null);

  const { data: previewDocDetail } = useConnectorDocument({
    path: { id: connectorId, docId: selectedPreviewDoc?.id ?? "" },
    enabled: selectedPreviewDoc !== null,
  });

  const {
    data: documentsResponse,
    isPending,
    isError,
  } = useConnectorDocuments({
    path: { id: connectorId },
    query: {
      limit: pageSize,
      offset,
      ...(search ? { search } : {}),
      ...(group ? { group } : {}),
    },
  });
  const deleteDocumentMutation = useDeleteConnectorDocument();

  const hasLoadError = isError;

  const documents = documentsResponse?.data ?? [];
  const paginationMeta: PaginationMeta | null =
    documentsResponse?.pagination ?? null;
  const totalDocuments = paginationMeta?.total ?? 0;

  // The shared Table is `table-fixed`: without explicit sizes every column
  // gets an equal width and the natural-width Access badges overflow under
  // the Last Updated column.
  const columns = useMemo<ColumnDef<KnowledgeBaseDocumentListItem>[]>(
    () => [
      {
        id: "title",
        accessorKey: "title",
        header: "Title",
        size: 280,
        cell: ({ row }) => (
          <div className="flex items-center gap-2 max-w-[400px]">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <button
              type="button"
              className="truncate text-sm font-medium hover:underline cursor-pointer border-none bg-transparent p-0 text-left outline-none"
              onClick={(event) => {
                event.stopPropagation();
                openPreviewDialog(row.original);
              }}
              title={row.original.title}
            >
              {row.original.title}
            </button>
          </div>
        ),
      },
      {
        id: "sourceUrl",
        accessorKey: "sourceUrl",
        header: "Source URL",
        size: 240,
        cell: ({ row }) =>
          row.original.sourceUrl ? (
            <Link
              href={row.original.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 min-w-0 text-sm text-muted-foreground hover:text-foreground hover:underline"
              onClick={(event) => event.stopPropagation()}
              title={row.original.sourceUrl}
            >
              <span className="truncate max-w-[300px]">
                {row.original.sourceUrl}
              </span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0" />
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground">-</span>
          ),
      },
      {
        id: "acl",
        accessorKey: "acl",
        header: "Access",
        size: 340,
        minSize: 240,
        cell: ({ row }) => <AclBadges acl={row.original.acl} />,
      },
      {
        id: "updatedAt",
        accessorKey: "updatedAt",
        header: "Last Updated",
        size: 160,
        cell: ({ row }) => (
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Clock className="h-3.5 w-3.5 shrink-0" />
            <span title={formatDate({ date: row.original.updatedAt })}>
              {formatDistanceToNow(new Date(row.original.updatedAt), {
                addSuffix: true,
              })}
            </span>
          </div>
        ),
      },
      {
        id: "actions",
        header: "Actions",
        size: 90,
        cell: ({ row }) => {
          const actions: TableRowAction[] = [
            {
              icon: <Eye className="h-4 w-4" />,
              label: "Preview",
              onClick: () => openPreviewDialog(row.original),
            },
            {
              icon: <Trash2 className="h-4 w-4" />,
              label: "Delete",
              variant: "destructive",
              onClick: () => setDeletingDoc(row.original),
            },
          ];
          return <TableRowActions actions={actions} />;
        },
      },
    ],
    [openPreviewDialog],
  );

  return (
    <div className="space-y-4">
      <TableFilters>
        <SearchInput
          value={search}
          syncQueryParams={false}
          placeholder="Search documents by title"
          onSearchChange={(nextValue) =>
            updateQueryParams({
              search: nextValue || null,
              page: "1",
            })
          }
        />
        {showGroupFilter && (
          <Select
            value={group || "all"}
            onValueChange={(value) =>
              updateQueryParams({
                group: value === "all" ? null : value,
                page: "1",
              })
            }
          >
            <SelectTrigger
              className="h-9 w-full text-sm sm:w-[200px]"
              aria-label="Filter by group"
            >
              <SelectValue placeholder="All groups" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All groups</SelectItem>
              {groupIds.map((groupId) => (
                <SelectItem key={groupId} value={groupId}>
                  {groupId}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </TableFilters>

      <DataTable
        columns={columns}
        data={documents}
        isLoading={isPending}
        manualPagination
        pagination={{
          pageIndex,
          pageSize,
          total: totalDocuments,
        }}
        onPaginationChange={setPagination}
        hasActiveFilters={Boolean(search) || Boolean(group)}
        onClearFilters={() =>
          updateQueryParams({
            search: null,
            group: null,
            page: "1",
          })
        }
        emptyMessage={
          hasLoadError
            ? "Failed to load documents. Please try again."
            : "No documents indexed yet. Sync a connector to populate this list."
        }
        filteredEmptyMessage={
          hasLoadError
            ? "Failed to load documents. Please try again."
            : "No documents match your filters."
        }
      />

      <StandardDialog
        open={selectedPreviewDoc !== null}
        onOpenChange={(open) => {
          if (!open) closePreviewDialog();
        }}
        title="Document Preview"
        size="medium"
      >
        {selectedPreviewDoc ? (
          <div className="space-y-2">
            {previewDocDetail?.content?.length ? (
              previewDocDetail.content.length > MAX_PREVIEW_CHARS ? (
                <div className="text-xs text-muted-foreground">
                  Preview truncated to {MAX_PREVIEW_CHARS.toLocaleString()}{" "}
                  characters.
                </div>
              ) : null
            ) : null}
            <pre className="max-h-[60vh] overflow-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap break-words">
              <code>
                {(previewDocDetail?.content ?? "").slice(0, MAX_PREVIEW_CHARS)}
              </code>
            </pre>
          </div>
        ) : null}
      </StandardDialog>

      <DeleteConfirmDialog
        open={deletingDoc !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingDoc(null);
        }}
        title="Delete Document"
        description="Are you sure you want to delete this document from the connector? It may return on a future connector re-sync."
        isPending={deleteDocumentMutation.isPending}
        onConfirm={async () => {
          if (!deletingDoc) return;
          const result = await deleteDocumentMutation.mutateAsync({
            id: connectorId,
            docId: deletingDoc.id,
          });
          if (result) {
            setDeletingDoc(null);
            if (documents.length === 1 && pageIndex > 0) {
              setPagination({ pageIndex: pageIndex - 1, pageSize });
            }
          }
        }}
        confirmLabel="Delete Document"
        pendingLabel="Deleting..."
      />
    </div>
  );
}
