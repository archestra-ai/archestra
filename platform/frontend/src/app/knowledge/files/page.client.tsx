"use client";

import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import {
  ChevronLeft,
  Files,
  FileText,
  Folder,
  FolderPlus,
  Pencil,
  Trash2,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { KnowledgePageLayout } from "@/app/knowledge/_parts/knowledge-page-layout";
import { AddToKnowledgeBaseDialog } from "@/app/knowledge/files/_parts/add-to-knowledge-base-dialog";
import { DirectoryDialog } from "@/app/knowledge/files/_parts/directory-dialog";
import { EditFileDialog } from "@/app/knowledge/files/_parts/edit-file-dialog";
import { UploadFileDialog } from "@/app/knowledge/files/_parts/upload-file-dialog";
import { BulkVisibilityDialog } from "@/components/bulk-visibility-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  FilePreviewDialog,
  type PreviewableDocument,
} from "@/components/files/file-preview-dialog";
import {
  CollectionFilters,
  FilterBar,
  filterSearchClass,
} from "@/components/filter-bar";
import { QueryLoadError } from "@/components/query-load-error";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { BulkActionsScope } from "@/components/ui/bulk-actions-context";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import { useSession } from "@/lib/auth/auth.query";
import { reportBulkOutcome } from "@/lib/bulk-action";
import { useControlledRowSelection } from "@/lib/hooks/use-bulk-selection";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import {
  type KnowledgeDirectory,
  type KnowledgeFile,
  type KnowledgeSelectionItem,
  ROOT_DIRECTORY,
  useAllMatchingKnowledgeFiles,
  useBulkDeleteKnowledgeItems,
  useBulkUpdateKnowledgeVisibility,
  useDeleteKnowledgeDirectory,
  useDeleteKnowledgeFile,
  useKnowledgeDirectories,
  useKnowledgeFiles,
} from "@/lib/knowledge/knowledge-file.query";
import { useTeams } from "@/lib/teams/team.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

/**
 * Directories and files share one table rather than sitting either side of a
 * split. A left rail cost ~220px of the only area that needed width, which
 * squeezed the columns until their headers wrapped one letter per line — and it
 * gave directories a second, inconsistent selection model. As rows they get the
 * same checkboxes, the same bulk actions, and the table gets the full width.
 */
type Row =
  | { kind: "directory"; id: string; directory: KnowledgeDirectory }
  | { kind: "file"; id: string; file: KnowledgeFile };

/**
 * The repository's three audiences map onto the app-wide scope vocabulary, so a
 * document's visibility reads exactly like an agent's or a project's instead of
 * inventing a second badge style for the same idea.
 */
const SCOPE_BY_VISIBILITY = {
  "org-wide": "org",
  "team-scoped": "team",
  private: "personal",
} as const;

/** The reverse of {@link SCOPE_BY_VISIBILITY}, for writing a scope back. */
const VISIBILITY_BY_SCOPE = {
  org: "org-wide",
  team: "team-scoped",
  personal: "private",
} as const;

function VisibilityBadge({
  visibility,
  teamIds,
  authorId,
}: {
  visibility: string;
  teamIds: string[];
  authorId?: string | null;
}) {
  const { data: teams } = useTeams();
  const { data: session } = useSession();
  const scope =
    SCOPE_BY_VISIBILITY[visibility as keyof typeof SCOPE_BY_VISIBILITY];
  if (!scope) return null;

  return (
    <ResourceVisibilityBadge
      scope={scope}
      teams={(teams ?? []).filter((team) => teamIds.includes(team.id))}
      authorId={authorId}
      authorName={undefined}
      currentUserId={session?.user?.id}
      // A private document is only ever listed to the person who uploaded it
      // (the repository filter sees to that), so "Me" is always the accurate
      // label here — and without it the cell renders a bare dash next to
      // labelled Organization and Team badges.
      showSelfAsMe
    />
  );
}

export default function KnowledgeFilesPage() {
  const { pageIndex, pageSize, offset, setPagination, updateQueryParams } =
    useDataTableQueryParams();

  /** null = the top level, which lists directories plus unfiled documents. */
  const [openDirectoryId, setOpenDirectoryId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [uploadOpen, setUploadOpen] = useState(false);
  const [addToKbOpen, setAddToKbOpen] = useState(false);
  const [directoryDialog, setDirectoryDialog] = useState<{
    open: boolean;
    directory?: KnowledgeDirectory;
  }>({ open: false });
  const [editFile, setEditFile] = useState<KnowledgeFile>();
  const [previewFile, setPreviewFile] = useState<PreviewableDocument>();

  const { data: directories = [] } = useKnowledgeDirectories();
  const {
    data,
    isFetching: isLoading,
    isLoadingError,
    refetch,
  } = useKnowledgeFiles({
    limit: pageSize,
    offset,
    // At the top level only unfiled documents are listed inline; a directory's
    // contents appear when you open it, so nothing is shown twice.
    directoryId: openDirectoryId ?? ROOT_DIRECTORY,
    search: search || undefined,
  });

  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkVisibilityOpen, setBulkVisibilityOpen] = useState(false);
  const bulkDelete = useBulkDeleteKnowledgeItems();
  const bulkVisibility = useBulkUpdateKnowledgeVisibility();
  const deleteFile = useDeleteKnowledgeFile();
  const deleteDirectory = useDeleteKnowledgeDirectory();

  const files = useMemo(() => data?.data ?? [], [data?.data]);
  const openDirectory = directories.find((d) => d.id === openDirectoryId);

  const rows: Row[] = useMemo(() => {
    const fileRows: Row[] = files.map((file) => ({
      kind: "file",
      id: `file:${file.id}`,
      file,
    }));
    if (openDirectoryId) return fileRows;

    // Directories are held client-side (there are few, and they are needed for
    // the move and upload pickers), so the search term has to be applied to
    // them here — the server only filters the documents. Without this, a search
    // that matches one document still lists every directory beside it.
    const term = search.trim().toLowerCase();
    const matching = term
      ? directories.filter((directory) =>
          directory.name.toLowerCase().includes(term),
        )
      : directories;

    return [
      ...matching.map(
        (directory): Row => ({
          kind: "directory",
          id: `dir:${directory.id}`,
          directory,
        }),
      ),
      ...fileRows,
    ];
  }, [directories, files, openDirectoryId, search]);

  /**
   * An escalation is remembered as the view it was made in, so opening a
   * different directory or changing the search drops it rather than silently
   * re-pointing "all 40 documents" at a different 40.
   */
  const viewSignature = JSON.stringify({ openDirectoryId, search });
  const [escalatedFor, setEscalatedFor] = useState<string | null>(null);
  const allMatchingSelected = escalatedFor === viewSignature;
  const { effectiveRowSelection, onRowSelectionChange } =
    useControlledRowSelection({
      rowSelection,
      setRowSelection,
      rows,
      getRowId: (row) => row.id,
      allMatchingSelected,
      clearEscalation: () => setEscalatedFor(null),
    });

  const selectedIds = useMemo(
    () =>
      Object.keys(effectiveRowSelection).filter(
        (id) => effectiveRowSelection[id],
      ),
    [effectiveRowSelection],
  );
  const selectedFileIds = selectedIds
    .filter((id) => id.startsWith("file:"))
    .map((id) => id.slice(5));
  const selectedDirectoryIds = selectedIds
    .filter((id) => id.startsWith("dir:"))
    .map((id) => id.slice(4));

  /**
   * How many DOCUMENTS the selection resolves to — not how many rows are
   * ticked. Selecting an empty directory used to look like a valid selection
   * and then fail with "no files were selected", which is true and useless.
   */
  const selectedFileCount =
    selectedFileIds.length +
    selectedDirectoryIds.reduce(
      (total, id) =>
        total + (directories.find((d) => d.id === id)?.fileCount ?? 0),
      0,
    );

  const { data: allMatchingFiles, isFetching: isFetchingAllMatching } =
    useAllMatchingKnowledgeFiles(
      {
        directoryId: openDirectoryId ?? ROOT_DIRECTORY,
        search: search || undefined,
      },
      { enabled: allMatchingSelected },
    );

  /**
   * What the action actually runs on. An escalation promised "every document
   * in this view", so it resolves to those documents alone — the ticked
   * directories are dropped rather than added on top, which would act on more
   * than the offer named.
   */
  const escalatedFileIds = allMatchingSelected
    ? (allMatchingFiles ?? []).map((file) => file.id)
    : null;
  /**
   * The ticked rows tagged with which route acts on them. An escalation
   * resolved to documents alone, so it contributes no directories.
   */
  const selectionItems: KnowledgeSelectionItem[] = allMatchingSelected
    ? (allMatchingFiles ?? []).map((file) => ({
        kind: "file" as const,
        id: file.id,
        name: file.filename,
      }))
    : [
        ...rows
          .filter(
            (row) => row.kind === "directory" && effectiveRowSelection[row.id],
          )
          .map((row) => ({
            kind: "directory" as const,
            id: row.id.slice(4),
            name: row.kind === "directory" ? row.directory.name : "",
          })),
        ...rows
          .filter((row) => row.kind === "file" && effectiveRowSelection[row.id])
          .map((row) => ({
            kind: "file" as const,
            id: row.id.slice(5),
            name: row.kind === "file" ? row.file.filename : "",
          })),
      ];

  const actionFileIds = escalatedFileIds ?? selectedFileIds;
  const actionDirectoryIds = escalatedFileIds ? [] : selectedDirectoryIds;
  const actionDocumentCount = escalatedFileIds
    ? escalatedFileIds.length
    : selectedFileCount;

  // Stable so the columns memo can depend on it without rebuilding every render.
  const clearSelection = useCallback(() => {
    setRowSelection({});
    setEscalatedFor(null);
  }, []);

  const columns: ColumnDef<Row>[] = useMemo(
    () => [
      createSelectColumn<Row>({
        rowLabel: (row) =>
          `Select ${
            row.kind === "directory" ? row.directory.name : row.file.filename
          }`,
        allLabel: "Select all files and directories on this page",
      }),
      {
        id: "name",
        header: "Name",
        size: 42,
        minSize: 260,
        cell: ({ row }) => {
          if (row.original.kind === "directory") {
            const directory = row.original.directory;
            return (
              <button
                type="button"
                onClick={() => {
                  setOpenDirectoryId(directory.id);
                  clearSelection();
                  updateQueryParams({ page: "1" });
                }}
                className="flex w-full min-w-0 items-center gap-2 text-left font-medium hover:underline"
              >
                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate" title={directory.name}>
                  {directory.name}
                </span>
                <span className="shrink-0 text-muted-foreground text-xs">
                  {directory.fileCount}
                </span>
              </button>
            );
          }
          const file = row.original.file;
          return (
            // Opens the document itself — PDFs in the browser's viewer, text
            // and images inline — so checking what a file says never requires
            // downloading it.
            <button
              type="button"
              className="flex w-full min-w-0 items-center gap-2 text-left"
              onClick={() =>
                setPreviewFile({
                  name: file.filename,
                  mimeType: file.mimeType,
                  contentUrl: `/api/knowledge-files/${file.id}/content`,
                })
              }
            >
              <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span
                className="truncate font-medium underline-offset-4 hover:underline"
                title={file.filename}
              >
                {file.filename}
              </span>
            </button>
          );
        },
      },
      {
        id: "visibility",
        header: "Visibility",
        size: 14,
        minSize: 130,
        cell: ({ row }) => (
          <VisibilityBadge
            visibility={
              row.original.kind === "directory"
                ? row.original.directory.visibility
                : row.original.file.visibility
            }
            teamIds={
              row.original.kind === "directory"
                ? row.original.directory.teamIds
                : row.original.file.teamIds
            }
            authorId={
              row.original.kind === "directory"
                ? row.original.directory.createdBy
                : row.original.file.uploadedBy
            }
          />
        ),
      },
      {
        id: "knowledgeBases",
        header: "Knowledge bases",
        size: 24,
        minSize: 170,
        cell: ({ row }) => {
          if (row.original.kind === "directory") {
            return <span className="text-muted-foreground text-sm">—</span>;
          }
          const bases = row.original.file.knowledgeBases ?? [];
          if (bases.length === 0) {
            // Stored is not the same as retrievable, and that difference is the
            // whole point of this page.
            return (
              <span className="text-muted-foreground text-sm">Not indexed</span>
            );
          }
          return (
            <span className="truncate text-sm">
              {bases.map((base) => base.name).join(", ")}
            </span>
          );
        },
      },
      {
        id: "uploaded",
        header: "Added",
        size: 10,
        minSize: 110,
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-muted-foreground text-sm">
            {formatRelativeTimeFromNow(
              row.original.kind === "directory"
                ? row.original.directory.createdAt
                : row.original.file.createdAt,
            )}
          </span>
        ),
      },
      {
        id: "actions",
        header: "Actions",
        // Pixel-sized like every other table's actions column, so the icon
        // buttons never clip while the sized columns scale.
        size: 110,
        enableHiding: false,
        cell: ({ row }) => {
          const item = row.original;
          if (item.kind === "directory") {
            return (
              <TableRowActions
                itemName={item.directory.name}
                actions={[
                  {
                    icon: <Pencil className="h-4 w-4" />,
                    label: "Edit",
                    permissions: { knowledgeSource: ["update"] },
                    onClick: () =>
                      setDirectoryDialog({
                        open: true,
                        directory: item.directory,
                      }),
                  },
                  {
                    icon: <Trash2 className="h-4 w-4" />,
                    label: "Delete",
                    variant: "destructive",
                    permissions: { knowledgeSource: ["delete"] },
                    onClick: () => deleteDirectory.mutate(item.directory.id),
                  },
                ]}
              />
            );
          }
          return (
            <TableRowActions
              itemName={item.file.filename}
              actions={[
                {
                  icon: <Pencil className="h-4 w-4" />,
                  label: "Edit",
                  permissions: { knowledgeSource: ["update"] },
                  onClick: () => setEditFile(item.file),
                },
                {
                  icon: <Trash2 className="h-4 w-4" />,
                  label: "Delete",
                  variant: "destructive",
                  permissions: { knowledgeSource: ["delete"] },
                  onClick: () => deleteFile.mutate(item.file.id),
                },
              ]}
            />
          );
        },
      },
    ],
    [deleteFile, deleteDirectory, updateQueryParams, clearSelection],
  );

  return (
    <KnowledgePageLayout
      title="Files"
      description="Documents uploaded directly — no connector needed. Add them to a knowledge base to make them retrievable by your agents."
      createLabel="Upload"
      onCreateClick={() => setUploadOpen(true)}
      // Only at the top level: directories are flat, so inside one there is no
      // sub-directory to create — the button would silently make a sibling you
      // cannot see from here.
      extraActions={
        openDirectoryId ? undefined : (
          <PermissionButton
            permissions={{ knowledgeSource: ["create"] }}
            variant="secondary"
            size="icon"
            aria-label="New directory"
            tooltip="New directory"
            onClick={() => setDirectoryDialog({ open: true })}
          >
            <FolderPlus className="h-4 w-4" />
          </PermissionButton>
        )
      }
      isPending={isLoading && files.length === 0}
    >
      <BulkActionsScope>
        <CollectionFilters>
          <FilterBar
            leading
            onClearFilters={
              search
                ? () => {
                    setSearch("");
                    updateQueryParams({ page: "1" });
                  }
                : undefined
            }
          >
            {openDirectory ? (
              <Button
                variant="ghost"
                size="sm"
                className="-ml-2"
                onClick={() => {
                  setOpenDirectoryId(null);
                  clearSelection();
                  updateQueryParams({ page: "1" });
                }}
              >
                <ChevronLeft className="mr-1 h-4 w-4" />
                <span>All files</span>
              </Button>
            ) : null}
            {openDirectory && (
              <span className="font-medium text-sm">{openDirectory.name}</span>
            )}

            <SearchInput
              isLoading={isLoading}
              value={search}
              onSearchChange={(value) => {
                setSearch(value);
                updateQueryParams({ page: "1" });
              }}
              // The term lives in local state and the page reset is handled just
              // above, so the component's own query-param sync would only add a
              // second router push per keystroke.
              syncQueryParams={false}
              placeholder="Search documents…"
              className={filterSearchClass}
            />
          </FilterBar>
        </CollectionFilters>

        {/* Visibility follows the ticked rows, not the document count: picking
            an empty directory selects something the bar has to be able to
            report on and clear, even though it resolves to no documents. */}
        <BulkActions
          count={allMatchingSelected ? actionDocumentCount : selectedIds.length}
          noun="document"
          label={`${actionDocumentCount} ${
            actionDocumentCount === 1 ? "document" : "documents"
          } selected`}
          onClear={clearSelection}
          busy={isFetchingAllMatching}
          selectAllMatching={{
            // Documents only. Directories arrive whole rather than a page at a
            // time, so none of them are hidden behind this offer.
            total: data?.pagination?.total ?? 0,
            pageFullySelected:
              rows.length > 0 && selectedIds.length === rows.length,
            active: allMatchingSelected,
            onSelectAll: () => setEscalatedFor(viewSignature),
            matchDescription: search
              ? "match this search query"
              : "are in this view",
          }}
        >
          <PermissionButton
            permissions={{ knowledgeSource: ["update"] }}
            variant="outline"
            size="sm"
            onClick={() => setBulkVisibilityOpen(true)}
          >
            <Pencil className="h-4 w-4" />
            <span>Edit visibility</span>
          </PermissionButton>
          <PermissionButton
            permissions={{ knowledgeSource: ["delete"] }}
            variant="destructive"
            size="sm"
            onClick={() => setBulkDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            <span>Delete</span>
          </PermissionButton>
          <PermissionButton
            permissions={{ knowledgeSource: ["update"] }}
            size="sm"
            // An empty directory resolves to nothing, so the action is
            // refused here rather than by an error that contradicts the
            // "selected" count next to it.
            disabled={actionDocumentCount === 0}
            tooltip={
              actionDocumentCount === 0
                ? "The selected directories have no documents in them yet."
                : undefined
            }
            onClick={() => setAddToKbOpen(true)}
          >
            <span>Add to knowledge base</span>
          </PermissionButton>
        </BulkActions>

        {isLoadingError ? (
          <QueryLoadError
            title="Could not load documents"
            onRetry={() => refetch()}
          />
        ) : (
          <DataTable
            columns={columns}
            data={rows}
            isLoading={isLoading}
            emptyIcon={Files}
            emptyMessage={
              openDirectory
                ? "This directory is empty. Upload a document into it to get started."
                : "No documents yet. Upload one to make it available to your agents."
            }
            getRowId={(row) => row.id}
            // The bulk bar above already names the count.
            hideSelectedCount
            rowSelection={effectiveRowSelection}
            onRowSelectionChange={onRowSelectionChange}
            // Cell contents (badges, knowledge-base names) cannot shrink, so a
            // narrow viewport scrolls the table instead of wrapping headers one
            // letter per line.
            tableClassName="min-w-[900px]"
            manualPagination
            pagination={{
              pageIndex,
              pageSize,
              total: data?.pagination?.total ?? 0,
            }}
            onPaginationChange={setPagination}
          />
        )}
      </BulkActionsScope>

      <UploadFileDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        directories={directories}
        defaultDirectoryId={openDirectoryId}
      />
      <DirectoryDialog
        open={directoryDialog.open}
        onOpenChange={(open) => setDirectoryDialog({ open })}
        directory={directoryDialog.directory}
      />
      <EditFileDialog
        open={!!editFile}
        onOpenChange={(open) => !open && setEditFile(undefined)}
        file={editFile}
        directories={directories}
      />
      <FilePreviewDialog
        open={!!previewFile}
        onOpenChange={(open) => !open && setPreviewFile(undefined)}
        file={previewFile}
      />
      {bulkDeleteOpen && (
        <DeleteConfirmDialog
          open={bulkDeleteOpen}
          onOpenChange={setBulkDeleteOpen}
          title="Delete selection"
          description={`Delete ${selectionItems.length} ${
            selectionItems.length === 1 ? "item" : "items"
          }? Deleting a directory takes the documents inside it too.`}
          isPending={bulkDelete.isPending}
          onConfirm={() => {
            bulkDelete.mutate(selectionItems, {
              onSuccess: (outcome) => {
                reportBulkOutcome({
                  outcome,
                  verb: "Deleted",
                  failureVerb: "delete",
                  noun: "item",
                });
                setBulkDeleteOpen(false);
                if (outcome.failed.length === 0) clearSelection();
              },
            });
          }}
          confirmLabel="Delete"
          pendingLabel="Deleting..."
        />
      )}

      {bulkVisibilityOpen && (
        <BulkVisibilityDialog
          // Documents carry team scoping but no per-person grants, so the
          // dialog's Users choice resolves to "private" — visible to you alone.
          items={selectionItems.map((item) => ({
            id: item.id,
            scope: "org" as const,
            teams: [],
            users: [],
          }))}
          noun="item"
          open={bulkVisibilityOpen}
          onOpenChange={setBulkVisibilityOpen}
          isPending={bulkVisibility.isPending}
          onApply={async (change) => {
            const outcome = await bulkVisibility.mutateAsync({
              items: selectionItems,
              visibility: VISIBILITY_BY_SCOPE[change.scope],
              teamIds: change.teamIds,
            });
            reportBulkOutcome({
              outcome,
              verb: "Updated",
              failureVerb: "update",
              noun: "item",
            });
            if (outcome.succeeded.length === 0) return false;
            if (outcome.failed.length === 0) clearSelection();
            return true;
          }}
        />
      )}

      <AddToKnowledgeBaseDialog
        open={addToKbOpen}
        onOpenChange={setAddToKbOpen}
        fileIds={actionFileIds}
        directoryIds={actionDirectoryIds}
        documentCount={actionDocumentCount}
        onIndexed={clearSelection}
      />
    </KnowledgePageLayout>
  );
}
