"use client";

import type { archestraApiTypes } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import { ExternalLink, Eye, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { SearchInput } from "@/components/search-input";
import { StandardDialog } from "@/components/standard-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import {
  type KnowledgeBaseDocumentListItem,
  useDeleteKnowledgeBaseDocument,
  useKnowledgeBaseDocuments,
} from "@/lib/knowledge/kb-document.query";
import { formatDate } from "@/lib/utils";

type PaginationMeta =
  archestraApiTypes.GetKnowledgeBaseDocumentsResponses["200"]["pagination"];

const DEFAULT_DOCUMENT_PAGE_SIZE = 10;

export function DocumentsTab({ knowledgeBaseId }: { knowledgeBaseId: string }) {
  const {
    searchParams,
    pageIndex,
    pageSize,
    offset,
    setPagination,
    updateQueryParams,
  } = useDataTableQueryParams({ defaultPageSize: DEFAULT_DOCUMENT_PAGE_SIZE });
  const search = searchParams.get("search") ?? "";
  const [selectedPreviewDoc, setSelectedPreviewDoc] =
    useState<KnowledgeBaseDocumentListItem | null>(null);
  const [deletingDoc, setDeletingDoc] =
    useState<KnowledgeBaseDocumentListItem | null>(null);

  const { data: documentsResponse, isPending } = useKnowledgeBaseDocuments({
    knowledgeBaseId,
    limit: pageSize,
    offset,
    search,
  });
  const deleteDocumentMutation = useDeleteKnowledgeBaseDocument();

  const documents = documentsResponse?.data ?? [];
  const paginationMeta: PaginationMeta | null =
    documentsResponse?.pagination ?? null;
  const totalDocuments = paginationMeta?.total ?? 0;

  const columns = useMemo<ColumnDef<KnowledgeBaseDocumentListItem>[]>(
    () => [
      {
        id: "title",
        accessorKey: "title",
        header: "Title",
        cell: ({ row }) => (
          <Button
            variant="link"
            size="sm"
            className="h-auto max-w-[360px] justify-start p-0 text-left font-medium"
            onClick={(event) => {
              event.stopPropagation();
              setSelectedPreviewDoc(row.original);
            }}
            title={row.original.title}
          >
            {row.original.title}
          </Button>
        ),
      },
      {
        id: "sourceUrl",
        accessorKey: "sourceUrl",
        header: "Source URL",
        cell: ({ row }) =>
          row.original.sourceUrl ? (
            <Link
              href={row.original.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-[320px] items-center gap-1 truncate text-sm text-muted-foreground hover:text-foreground hover:underline"
              onClick={(event) => event.stopPropagation()}
              title={row.original.sourceUrl}
            >
              <span className="truncate">{row.original.sourceUrl}</span>
              <ExternalLink className="h-3 w-3 shrink-0" />
            </Link>
          ) : (
            <span className="text-sm text-muted-foreground">-</span>
          ),
      },
      {
        id: "connectorType",
        accessorKey: "connectorType",
        header: "Connector",
        cell: ({ row }) => (
          <Badge variant="secondary" className="capitalize">
            {row.original.connectorType}
          </Badge>
        ),
      },
      {
        id: "updatedAt",
        accessorKey: "updatedAt",
        header: "Last Updated",
        cell: ({ row }) => (
          <span
            className="text-sm text-muted-foreground"
            title={formatDate({ date: row.original.updatedAt })}
          >
            {formatDistanceToNow(new Date(row.original.updatedAt), {
              addSuffix: true,
            })}
          </span>
        ),
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={(event) => {
                event.stopPropagation();
                setSelectedPreviewDoc(row.original);
              }}
              title="Preview document"
            >
              <Eye className="h-4 w-4 text-muted-foreground" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={(event) => {
                event.stopPropagation();
                setDeletingDoc(row.original);
              }}
              title="Delete document"
            >
              <Trash2 className="h-4 w-4 text-muted-foreground" />
            </Button>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <SearchInput
          value={search}
          syncQueryParams={false}
          placeholder="Search documents by title..."
          onSearchChange={(nextValue) =>
            updateQueryParams({
              search: nextValue || null,
              page: "1",
            })
          }
        />
      </div>

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
        hasActiveFilters={Boolean(search)}
        filteredEmptyMessage="No documents match your search."
        onClearFilters={() =>
          updateQueryParams({
            search: null,
            page: "1",
          })
        }
        emptyMessage="No documents indexed yet. Sync a connector to populate this list."
      />

      <StandardDialog
        open={selectedPreviewDoc !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedPreviewDoc(null);
        }}
        title={selectedPreviewDoc?.title ?? "Document Preview"}
        description="Preview raw indexed document content."
        size="medium"
      >
        {selectedPreviewDoc ? (
          <pre className="max-h-[60vh] overflow-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap break-words">
            <code>{selectedPreviewDoc.content}</code>
          </pre>
        ) : null}
      </StandardDialog>

      <DeleteConfirmDialog
        open={deletingDoc !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingDoc(null);
        }}
        title="Delete Document"
        description="Are you sure you want to delete this document from the knowledge base? It may return on a future connector re-sync."
        isPending={deleteDocumentMutation.isPending}
        onConfirm={async () => {
          if (!deletingDoc) return;
          const result = await deleteDocumentMutation.mutateAsync({
            knowledgeBaseId,
            docId: deletingDoc.id,
          });
          if (result) {
            setDeletingDoc(null);
          }
        }}
        confirmLabel="Delete Document"
        pendingLabel="Deleting..."
      />
    </div>
  );
}
