"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import { ExternalLink, Eye, FileText, Trash2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { AclBadges } from "@/app/knowledge/connectors/_parts/acl-badges";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  CollectionFilters,
  FilterBar,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import { RelativeTime } from "@/components/relative-time";
import { SearchInput } from "@/components/search-input";
import { StandardDialog } from "@/components/standard-dialog";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { BulkActionsScope } from "@/components/ui/bulk-actions-context";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { reportBulkOutcome } from "@/lib/bulk-action";
import { useControlledRowSelection } from "@/lib/hooks/use-bulk-selection";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import { useConnectorUserGroups } from "@/lib/knowledge/connector.query";
import {
  type KnowledgeBaseDocumentListItem,
  useBulkDeleteConnectorDocuments,
  useConnectorDocument,
  useConnectorDocuments,
  useDeleteConnectorDocument,
} from "@/lib/knowledge/kb-document.query";
import { GROUP_ROSTER_NOUN, type RosterNoun } from "./roster-noun";

type PaginationMeta =
  archestraApiTypes.GetConnectorDocumentsResponses["200"]["pagination"];

const DEFAULT_DOCUMENT_PAGE_SIZE = 10;
const MAX_PREVIEW_CHARS = 20_000;

export function ConnectorDocumentsTable({
  connectorId,
  showGroupFilter = false,
  noun = GROUP_ROSTER_NOUN,
}: {
  connectorId: string;
  /** Auto-sync connectors only: filter documents by upstream group. */
  showGroupFilter?: boolean;
  noun?: RosterNoun;
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
  // Rows are named upstream (a Notion workspace, a Jira group); the group id
  // is only the authorization identity. Filter options and Access badges both
  // show the name, so this tab reads the same as the roster tab.
  const groupOptions = useMemo(
    () =>
      [
        ...new Map(
          (userGroups?.groups ?? []).map((group) => [
            group.groupId,
            group.name ?? group.groupId,
          ]),
        ),
      ]
        .map(([groupId, label]) => ({ groupId, label }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [userGroups?.groups],
  );
  const groupNamesByToken = useMemo(
    () =>
      new Map(
        (userGroups?.groups ?? []).flatMap((group) =>
          group.name ? [[group.token, group.name] as const] : [],
        ),
      ),
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
    isFetching,
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
  const bulkDelete = useBulkDeleteConnectorDocuments();
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [selectAllMatchingFor, setSelectAllMatchingFor] = useState<
    string | null
  >(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const hasLoadError = isError;

  const documents = documentsResponse?.data ?? [];
  const paginationMeta: PaginationMeta | null =
    documentsResponse?.pagination ?? null;
  const totalDocuments = paginationMeta?.total ?? 0;

  // Changing a filter invalidates an escalation rather than silently
  // re-pointing "all N" at a different N.
  const filterSignature = `${connectorId}|${search}|${group}`;
  const allMatchingActive = selectAllMatchingFor === filterSignature;
  const { effectiveRowSelection, onRowSelectionChange } =
    useControlledRowSelection({
      rowSelection,
      setRowSelection,
      rows: documents,
      getRowId: (row) => row.id,
      allMatchingSelected: allMatchingActive,
      clearEscalation: () => setSelectAllMatchingFor(null),
    });
  const clearSelection = useCallback(() => {
    setRowSelection({});
    setSelectAllMatchingFor(null);
  }, []);

  const selectedDocuments = documents.filter(
    (document) => effectiveRowSelection[document.id],
  );
  // Escalating does not fetch the matching rows — the delete sends the filter,
  // so the only thing needed on screen is how many there are. That is what
  // makes "select all 22,921" honest rather than a page-sized lie.
  const selectedCount = allMatchingActive
    ? totalDocuments
    : selectedDocuments.length;

  // The shared Table is `table-fixed`: without explicit sizes every column
  // gets an equal width and the natural-width Access badges overflow under
  // the Last Updated column.
  const columns = useMemo<ColumnDef<KnowledgeBaseDocumentListItem>[]>(
    () => [
      createSelectColumn<KnowledgeBaseDocumentListItem>({
        rowLabel: (document) => `Select ${document.title}`,
        allLabel: "Select all documents on this page",
      }),
      {
        id: "title",
        accessorKey: "title",
        header: "Title",
        // The one cell with genuinely variable content, so it takes the width
        // the spelled-out Source URL column used to occupy.
        size: 460,
        minSize: 240,
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
            <button
              type="button"
              className="truncate text-sm font-medium hover:underline cursor-pointer border-none bg-transparent p-0 text-left outline-none"
              onClick={(event) => {
                event.stopPropagation();
                openPreviewDialog(row.original);
              }}
              title={
                row.original.sourceUrl
                  ? `${row.original.title}\n${row.original.sourceUrl}`
                  : row.original.title
              }
            >
              {row.original.title}
            </button>
          </div>
        ),
      },
      {
        id: "acl",
        accessorKey: "acl",
        header: "Access",
        size: 340,
        minSize: 240,
        cell: ({ row }) => (
          <AclBadges
            acl={row.original.acl}
            groupNamesByToken={groupNamesByToken}
            noun={noun}
          />
        ),
      },
      {
        id: "updatedAt",
        accessorKey: "updatedAt",
        header: "Last Updated",
        size: 160,
        cell: ({ row }) => (
          <RelativeTime date={row.original.updatedAt} showIcon />
        ),
      },
      {
        id: "actions",
        header: "Actions",
        size: 130,
        cell: ({ row }) => {
          const { sourceUrl } = row.original;
          const actions: TableRowAction[] = [
            {
              icon: <Eye className="h-4 w-4" />,
              label: "Preview",
              onClick: () => openPreviewDialog(row.original),
            },
            // Every document on one connector shares a host and a URL shape,
            // so a column spelling each one out was a column of near-identical
            // strings. The link itself is what anyone wanted from it.
            {
              icon: <ExternalLink className="h-4 w-4" />,
              label: "Open at source",
              href: sourceUrl ?? undefined,
              external: true,
              disabled: !sourceUrl,
              disabledTooltip: "This document has no source URL",
            },
            {
              icon: <Trash2 className="h-4 w-4" />,
              label: "Delete",
              variant: "destructive",
              onClick: () => setDeletingDoc(row.original),
            },
          ];
          return (
            <TableRowActions actions={actions} itemName={row.original.title} />
          );
        },
      },
    ],
    [openPreviewDialog, groupNamesByToken, noun],
  );

  return (
    <BulkActionsScope>
      <CollectionFilters>
        <FilterBar>
          <SearchInput
            isLoading={isFetching}
            value={search}
            syncQueryParams={false}
            placeholder="Search documents by title"
            className={filterSearchClass}
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
                size="sm"
                className={filterControlClass({ active: Boolean(group) })}
                aria-label={`Filter by ${noun.singular}`}
              >
                <SelectValue placeholder={`All ${noun.plural}`} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{`All ${noun.plural}`}</SelectItem>
                {groupOptions.map(({ groupId, label }) => (
                  <SelectItem key={groupId} value={groupId}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </FilterBar>
      </CollectionFilters>

      <BulkActions
        count={selectedCount}
        noun="document"
        onClear={clearSelection}
        busy={bulkDelete.isPending}
        maxSelection={null}
        selectAllMatching={{
          total: totalDocuments,
          pageFullySelected:
            documents.length > 0 &&
            documents.every((document) => effectiveRowSelection[document.id]),
          active: allMatchingActive,
          onSelectAll: () => setSelectAllMatchingFor(filterSignature),
          matchDescription: "match this search",
          // The delete sends the filter rather than an id list, so there is no
          // cap for the matching set to outgrow.
        }}
      >
        <PermissionButton
          permissions={{ knowledgeSource: ["delete"] }}
          variant="destructive"
          size="sm"
          onClick={() => setBulkDeleteOpen(true)}
        >
          <Trash2 className="h-4 w-4" />
          <span>Delete</span>
        </PermissionButton>
      </BulkActions>

      <DataTable
        columns={columns}
        data={documents}
        getRowId={(row) => row.id}
        rowSelection={effectiveRowSelection}
        onRowSelectionChange={onRowSelectionChange}
        hideSelectedCount
        isLoading={isFetching}
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

      {bulkDeleteOpen && (
        <DeleteConfirmDialog
          open={bulkDeleteOpen}
          onOpenChange={setBulkDeleteOpen}
          title="Delete documents"
          description={`Delete ${selectedCount} ${
            selectedCount === 1 ? "document" : "documents"
          }? They stop being searchable straight away. The next sync brings back anything still present at the source — to keep them out, remove them there or narrow this connector's scope.`}
          isPending={bulkDelete.isPending}
          onConfirm={() => {
            bulkDelete.mutate(
              allMatchingActive
                ? {
                    connectorId,
                    all: {
                      ...(search ? { search } : {}),
                      ...(group ? { group } : {}),
                    },
                  }
                : { connectorId, documents: selectedDocuments },
              {
                onSuccess: (outcome) => {
                  reportBulkOutcome({
                    outcome,
                    verb: "Deleted",
                    failureVerb: "delete",
                    noun: "document",
                  });
                  setBulkDeleteOpen(false);
                  if (outcome.failed.length === 0) clearSelection();
                  // Emptying the last page would otherwise leave the table on a
                  // page that no longer exists.
                  const removed = outcome.affected ?? outcome.succeeded.length;
                  if (removed >= documents.length && pageIndex > 0) {
                    setPagination({ pageIndex: pageIndex - 1, pageSize });
                  }
                },
              },
            );
          }}
          confirmLabel="Delete documents"
          pendingLabel="Deleting..."
        />
      )}
    </BulkActionsScope>
  );
}
