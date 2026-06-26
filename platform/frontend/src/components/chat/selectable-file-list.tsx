"use client";

import { Download, MoreHorizontal, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import {
  type FileListItem,
  FileSection,
} from "@/components/chat/file-list-section";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { downloadFiles } from "@/lib/chat/download-files";
import {
  pruneSelectedIds,
  selectAllIds,
  selectionCheckState,
  toggleSelectedId,
} from "@/lib/chat/file-selection";

/**
 * The list-view body shared by the chat and project Files panels: a "Select"
 * toggle, row checkboxes + "Select all", a bottom Download/Delete bar, and a
 * per-row "⋯" menu. The list/detail navigation and the delete confirm live in
 * the caller; this component reports opens via `onOpen` and delete requests via
 * `onRequestDelete`.
 *
 * A row is "manageable" (selectable / downloadable / deletable) when it has a
 * byte endpoint (`contentUrl`); the in-memory artifact row (empty `contentUrl`)
 * and the pinned instructions `leading` row are never selected. Generic over the
 * item type so callers keep their own richer item shape without casts.
 */
export function SelectableFileList<T extends FileListItem>({
  sections,
  leading,
  canManage,
  selectedId,
  onOpen,
  onRequestDelete,
  renderItemActions,
}: {
  sections: { title?: string; items: T[] }[];
  leading?: ReactNode;
  canManage: boolean;
  /** The open file's id, highlighted in the list while it previews beside it. */
  selectedId?: string | null;
  onOpen: (id: string) => void;
  /** `onComplete` receives the ids that failed, so the caller can reconcile. */
  onRequestDelete: (
    items: T[],
    onComplete?: (failedIds: string[]) => void,
  ) => void;
  /** Custom trailing actions for a row (e.g. the artifact's copy/PDF). */
  renderItemActions?: (item: T) => ReactNode;
}) {
  const managed = sections.flatMap((s) => s.items).filter(isManageable);
  const managedCount = managed.length;
  const managedKey = managed.map((f) => f.id).join("|");

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const selectedItems = managed.filter((f) => selectedIds.has(f.id));
  const { allChecked, someChecked } = selectionCheckState(
    selectedItems.length,
    managedCount,
  );

  // Drop selections whose files vanished after a refetch so counts/"select all"
  // stay honest.
  useEffect(() => {
    setSelectedIds((prev) =>
      pruneSelectedIds(prev, managedKey ? managedKey.split("|") : []),
    );
  }, [managedKey]);

  const exitSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };
  const selection = selectionMode
    ? {
        selectedIds,
        onToggle: (id: string) =>
          setSelectedIds((prev) => toggleSelectedId(prev, id)),
        isSelectable: (id: string) => managed.some((f) => f.id === id),
      }
    : undefined;

  const handleBulkDelete = () =>
    onRequestDelete(selectedItems, (failedIds) => {
      if (failedIds.length === 0) exitSelection();
      else setSelectedIds(new Set(failedIds));
    });

  // Headers only earn their place when more than one non-empty group shows.
  const showHeaders = sections.filter((s) => s.items.length > 0).length > 1;

  const renderActions = (item: FileListItem): ReactNode => {
    const custom = renderItemActions?.(item as T);
    if (custom != null) return custom;
    if (!canManage || !isManageable(item)) return null;
    return (
      <FileRowMenu item={item} onDelete={() => onRequestDelete([item as T])} />
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 pt-3 pb-2">
        {selectionMode ? (
          <>
            <label
              htmlFor="files-select-all"
              className="flex items-center gap-2 text-xs text-muted-foreground"
            >
              <Checkbox
                id="files-select-all"
                checked={
                  allChecked ? true : someChecked ? "indeterminate" : false
                }
                onCheckedChange={() =>
                  setSelectedIds(
                    selectAllIds(
                      allChecked,
                      managed.map((f) => f.id),
                    ),
                  )
                }
                aria-label="Select all files"
              />
              Select all
            </label>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={exitSelection}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <span className="text-xs text-muted-foreground">
              {managedCount} {managedCount === 1 ? "file" : "files"}
            </span>
            {canManage && managedCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => setSelectionMode(true)}
              >
                Select
              </Button>
            )}
          </>
        )}
      </div>

      {/* The open file's row stays highlighted while it previews beside the
          list (split view); harmless when expanded (list hidden) or idle. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {sections.map((section, i) => (
          <FileSection
            key={section.title ?? `section-${i}`}
            title={showHeaders ? section.title : undefined}
            items={section.items}
            selectedId={selectedId ?? null}
            onSelect={onOpen}
            selection={selection}
            leading={i === 0 && !selectionMode ? leading : undefined}
            renderActions={renderActions}
          />
        ))}
      </div>

      {selectionMode && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t px-3 py-2">
          <span className="text-xs text-muted-foreground">
            {selectedItems.length} selected
          </span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              disabled={selectedItems.length === 0}
              onClick={() => downloadFiles(selectedItems)}
            >
              <Download className="h-4 w-4" />
              Download
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive"
              disabled={selectedItems.length === 0}
              onClick={handleBulkDelete}
            >
              <Trash2 className="h-4 w-4" />
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// === internal ===

/** A row has actions worth managing once it has a byte endpoint to act on. */
function isManageable(item: FileListItem): boolean {
  return item.contentUrl !== "";
}

/** A "⋯" menu of single-file actions (Download + Delete) for a managed file. */
function FileRowMenu({
  item,
  onDelete,
}: {
  item: FileListItem;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="More actions"
          className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">Actions for {item.name}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {item.contentUrl && (
          <DropdownMenuItem asChild>
            <a href={item.contentUrl} download={item.name}>
              <Download className="h-4 w-4" />
              Download
            </a>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={(e) => {
            e.preventDefault();
            onDelete();
          }}
        >
          <Trash2 className="h-4 w-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
