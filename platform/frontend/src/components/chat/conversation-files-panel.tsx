"use client";

import { PROJECT_INSTRUCTIONS_FILENAME } from "@archestra/shared";
import {
  Check,
  ChevronLeft,
  Copy,
  Download,
  File as FileIcon,
  MoreVertical,
  Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ConversationArtifactPanel } from "@/components/chat/conversation-artifact";
import {
  type FileListItem,
  FileSection,
} from "@/components/chat/file-list-section";
import { FilePreview } from "@/components/chat/file-preview";
import {
  INSTRUCTIONS_SELECTION,
  InstructionsRow,
  ProjectInstructionsPanel,
} from "@/components/chat/project-instructions";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useBulkDeleteConversationFiles,
  useConversationFiles,
  useDeleteConversationFile,
} from "@/lib/chat/chat.query";
import {
  assembleFileSections,
  type ConversationFileItem,
  isManagedFile,
} from "@/lib/chat/conversation-files";
import { downloadFiles } from "@/lib/chat/download-files";
import { printMarkdownElementAsPdf } from "@/lib/chat/print-markdown";
import { useProject } from "@/lib/projects/projects.query";
import { cn } from "@/lib/utils";

interface ConversationFilesPanelProps {
  conversationId: string | undefined;
  artifact: string | null | undefined;
  /** Set when the chat belongs to a project — enables the pinned instructions. */
  projectId?: string | null;
  onClose: () => void;
}

export function ConversationFilesPanel({
  conversationId,
  artifact,
  projectId,
  onClose,
}: ConversationFilesPanelProps) {
  const { data: files } = useConversationFiles(conversationId);
  const { data: project } = useProject(projectId ?? undefined);
  // Editing instructions requires manage rights; in a chat the participant is
  // the owner (a shared member sees them read-only). viewerRole replaces the old
  // isOwner flag.
  const isProjectOwner = project?.viewerRole === "owner";
  const sections = assembleFileSections({ files, artifact });
  const { generated, attachments } = sections;

  // Only the conversation owner may delete its files; a shared/project viewer
  // sees them read-only (the backend computes and enforces this).
  const canManageFiles = files?.canManageFiles ?? false;

  // In a project chat, instructions.md is surfaced only as the pinned entry —
  // keep it out of the ordinary project file list.
  const projectFiles = sections.projectFiles.filter(
    (f) => f.name !== PROJECT_INSTRUCTIONS_FILENAME,
  );
  const hasArtifact = !!artifact && artifact.trim().length > 0;

  // Default to previewing the artifact when one exists as the panel opens, in
  // the full-height detail view.
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    hasArtifact ? "artifact" : null,
  );
  const [view, setView] = useState<"list" | "detail">(() =>
    hasArtifact ? "detail" : "list",
  );
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<
    ConversationFileItem[] | null
  >(null);

  // This chat's own outputs and the project's files are one group ("Results");
  // only attachments stand apart.
  const results = [...generated, ...projectFiles];
  const all = [...results, ...attachments];
  const selected = all.find((f) => f.id === selectedId) ?? null;
  const byId = new Map(all.map((f) => [f.id, f]));

  // The pinned instructions entry only exists in a project chat. Its sentinel
  // selection is not a file, so it must be excluded from the "selected file"
  // bookkeeping below.
  const showInstructions = projectId != null;
  const instructionsSelected =
    showInstructions && selectedId === INSTRUCTIONS_SELECTION;
  const instructionsSelectedRef = useRef(false);
  instructionsSelectedRef.current = instructionsSelected;

  // The Results header only earns its place when attachments sit beside it; a
  // lone group needs no label to tell it apart.
  const showHeaders = results.length > 0 && attachments.length > 0;

  // Files the user can select / download / delete (everything but the in-memory
  // artifact and the pinned instructions row).
  const managed = all.filter(isManagedFile);
  const managedCount = managed.length;
  const managedKey = managed.map((f) => f.id).join("|");
  const selectedItems = managed.filter((f) => selectedIds.has(f.id));
  const allChecked = managedCount > 0 && selectedItems.length === managedCount;
  const someChecked = selectedItems.length > 0 && !allChecked;

  const deleteFile = useDeleteConversationFile(conversationId);
  const bulkDelete = useBulkDeleteConversationFiles(conversationId);
  const deletePending = deleteFile.isPending || bulkDelete.isPending;

  const openFile = (id: string) => {
    setSelectedId(id);
    setView("detail");
  };
  const backToList = () => setView("list");
  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelectedIds(allChecked ? new Set() : new Set(managed.map((f) => f.id)));
  const exitSelection = () => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  };

  // download_file outputs only (the artifact has its own default handling).
  const generatedFileIds = generated
    .filter((f) => f.source === "generated")
    .map((f) => f.id);
  const newestGeneratedId = generatedFileIds.at(-1);
  const generatedKey = generatedFileIds.join("|");
  const filesLoaded = files !== undefined;

  // Drop selections whose files have disappeared after a refetch so counts and
  // "select all" stay honest.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const ids = new Set(managedKey ? managedKey.split("|") : []);
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [managedKey]);

  // Clear the preview if the selected file disappears (e.g. artifact cleared or
  // the open file was deleted) and fall back to the list. The instructions
  // sentinel is never a file, so it must not count as missing.
  const selectedMissing =
    selectedId !== null && !instructionsSelected && selected === null;
  useEffect(() => {
    if (selectedMissing) {
      setSelectedId(null);
      setView("list");
    }
  }, [selectedMissing]);

  // Keep a valid preview target when nothing is selected (artifact first, then
  // the newest generated file). This does NOT force the detail view, so going
  // back to the list — or deleting the open file — doesn't yank the user back
  // into a preview.
  useEffect(() => {
    if (selectedId !== null) return;
    if (hasArtifact) {
      setSelectedId("artifact");
    } else if (newestGeneratedId) {
      setSelectedId(newestGeneratedId);
    }
  }, [selectedId, hasArtifact, newestGeneratedId]);

  // Follow the latest produced output: when the artifact is (re)written switch
  // back to it, when a download_file output is created switch to that file —
  // popping the full-height detail view to the newest result. The first loaded
  // set is captured as a baseline so existing files don't hijack the view when
  // the panel opens (the initial artifact is handled by the state initializer;
  // a no-artifact chat opens its newest file here).
  const prevArtifactRef = useRef<string | null | undefined>(undefined);
  const seenGeneratedRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!filesLoaded) return;
    const ids = generatedKey ? generatedKey.split("|") : [];
    const prevGenerated = seenGeneratedRef.current;
    const prevArtifact = prevArtifactRef.current;
    seenGeneratedRef.current = new Set(ids);
    prevArtifactRef.current = artifact;
    if (prevGenerated === null) {
      if (!hasArtifact && ids.length > 0) {
        setSelectedId(ids[ids.length - 1]);
        setView("detail");
      }
      return; // baseline only
    }
    // Don't yank the view away from the instructions editor (and its unsaved
    // draft) when a new output lands while the owner is editing.
    if (instructionsSelectedRef.current) return;

    if (hasArtifact && artifact !== prevArtifact) {
      setSelectedId("artifact");
      setView("detail");
      return;
    }
    const fresh = ids.filter((id) => !prevGenerated.has(id));
    if (fresh.length > 0) {
      setSelectedId(fresh[fresh.length - 1]);
      setView("detail");
    }
  }, [filesLoaded, generatedKey, artifact, hasArtifact]);

  // The artifact is rendered once and kept mounted whenever it exists, so the
  // row / detail-header "Download as PDF" button has rendered content to print
  // even when the artifact isn't the open file. It fills the detail body when
  // selected, and is hidden otherwise.
  const artifactRef = useRef<HTMLDivElement>(null);
  const handleDownloadArtifactPdf = () =>
    printMarkdownElementAsPdf(artifactRef.current, "Artifact");
  const artifactSelected = selected?.source === "artifact";

  const requestDelete = (items: ConversationFileItem[]) =>
    setPendingDelete(items);

  const handleConfirmDelete = async () => {
    const items = pendingDelete;
    if (!items || items.length === 0) return;
    const openId = selectedId;
    // Collect the ids that failed so we don't navigate away from, or deselect,
    // files that are still there.
    let failed = new Set<string>();
    if (items.length === 1) {
      try {
        await deleteFile.mutateAsync(items[0]);
      } catch {
        failed = new Set([items[0].id]);
      }
    } else {
      const { failedIds } = await bulkDelete.mutateAsync(items);
      failed = new Set(failedIds);
    }
    setPendingDelete(null);
    if (selectionMode) {
      if (failed.size === 0) exitSelection();
      else setSelectedIds(failed); // keep only the failures selected
    }
    // Leave the detail view only if the open file was actually deleted.
    if (openId && items.some((i) => i.id === openId) && !failed.has(openId)) {
      setSelectedId(null);
      setView("list");
    }
  };

  // Trailing per-row actions: the artifact keeps Copy / Download-as-PDF; managed
  // files get a "⋯" menu (Download + Delete) when the user can manage them, and
  // otherwise fall back to FileSection's plain download link.
  const renderRowActions = (item: FileListItem): ReactNode => {
    if (item.source === "artifact") {
      return (
        <ArtifactRowActions
          content={artifact ?? ""}
          onDownloadPdf={handleDownloadArtifactPdf}
        />
      );
    }
    if (!canManageFiles) return null;
    const file = byId.get(item.id);
    if (!file) return null;
    return <FileRowMenu item={file} onDelete={() => requestDelete([file])} />;
  };

  const selection = selectionMode
    ? {
        selectedIds,
        onToggle: toggleSelect,
        isSelectable: (id: string) => {
          const f = byId.get(id);
          return !!f && isManagedFile(f);
        },
      }
    : undefined;

  // A project chat always shows the pinned instructions row, so the empty state
  // only applies to non-project chats with nothing to show.
  if (!showInstructions && results.length === 0 && attachments.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center text-xs text-muted-foreground">
        <FileIcon className="mb-2 h-6 w-6 opacity-50" />
        <p className="font-medium">No files yet</p>
        <p className="mt-1">
          Artifacts, generated files, and attachments for this conversation will
          appear here.
        </p>
      </div>
    );
  }

  const detailName = instructionsSelected
    ? "Instructions"
    : (selected?.name ?? "");

  return (
    <div className="flex h-full flex-col">
      {view === "list" && (
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
                    onCheckedChange={toggleAll}
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
                {canManageFiles && managedCount > 0 && (
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

          {/* The list never highlights a "current" row: opening a file drills
              into the full-height detail view, so there's no list-beside-preview
              for a selection marker to point at. Pass selectedId={null}. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            <FileSection
              title={showHeaders ? "Results" : undefined}
              items={results}
              selectedId={null}
              onSelect={openFile}
              selection={selection}
              leading={
                showInstructions && !selectionMode ? (
                  <InstructionsRow
                    onSelect={() => openFile(INSTRUCTIONS_SELECTION)}
                  />
                ) : undefined
              }
              renderActions={renderRowActions}
            />
            <FileSection
              title={showHeaders ? "Attachments" : undefined}
              items={attachments}
              selectedId={null}
              onSelect={openFile}
              selection={selection}
              renderActions={renderRowActions}
            />
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
                  onClick={() => requestDelete(selectedItems)}
                >
                  <Trash2 className="h-4 w-4" />
                  Delete
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {view === "detail" && (
        <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground"
            onClick={backToList}
          >
            <ChevronLeft className="h-4 w-4" />
            Files
          </Button>
          <span className="shrink-0 text-muted-foreground">·</span>
          <span
            className="min-w-0 flex-1 truncate text-sm font-medium"
            title={detailName}
          >
            {detailName}
          </span>
          {artifactSelected ? (
            <ArtifactRowActions
              content={artifact ?? ""}
              onDownloadPdf={handleDownloadArtifactPdf}
            />
          ) : (
            selected && (
              <div className="flex shrink-0 items-center">
                {selected.contentUrl && (
                  <a
                    href={selected.contentUrl}
                    download={selected.name}
                    title={`Download ${selected.name}`}
                    className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Download className="h-4 w-4" />
                    <span className="sr-only">Download {selected.name}</span>
                  </a>
                )}
                {canManageFiles && (
                  <button
                    type="button"
                    onClick={() => requestDelete([selected])}
                    title={`Delete ${selected.name}`}
                    className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                    <span className="sr-only">Delete {selected.name}</span>
                  </button>
                )}
              </div>
            )
          )}
        </div>
      )}

      {view === "detail" &&
        !artifactSelected &&
        instructionsSelected &&
        projectId && (
          <ProjectInstructionsPanel
            projectId={projectId}
            isOwner={isProjectOwner}
            onClose={backToList}
          />
        )}

      {view === "detail" &&
        !artifactSelected &&
        !instructionsSelected &&
        selected && <FilePreview file={selected} onClose={backToList} />}

      {hasArtifact && (
        <div
          ref={artifactRef}
          className={cn(
            view === "detail" && artifactSelected
              ? "min-h-0 flex-1 overflow-auto"
              : "hidden",
          )}
        >
          <ConversationArtifactPanel
            artifact={artifact}
            isOpen
            onToggle={onClose}
            embedded
            hideHeader
          />
        </div>
      )}

      <DeleteConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={
          (pendingDelete?.length ?? 0) === 1
            ? `Delete “${pendingDelete?.[0]?.name}”?`
            : `Delete ${pendingDelete?.length ?? 0} files?`
        }
        description={
          // A project file — or a file generated in a project chat — is shared,
          // so deleting it removes it for everyone with access to the project.
          pendingDelete?.some(
            (i) =>
              i.source === "project" ||
              (i.source === "generated" && projectId != null),
          )
            ? "This file is part of the project and will be removed for everyone with access to it. This can't be undone."
            : "This can't be undone."
        }
        isPending={deletePending}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}

// === internal components ===

/**
 * Row actions for the artifact: copy the in-memory markdown and download it as a
 * PDF. The artifact has no byte endpoint, so it doesn't get the plain download
 * link the other rows use.
 */
function ArtifactRowActions({
  content,
  onDownloadPdf,
}: {
  content: string;
  onDownloadPdf: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — nothing to do.
    }
  };

  return (
    <div className="flex shrink-0 items-center pr-1">
      <button
        type="button"
        onClick={handleCopy}
        title="Copy"
        className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        <span className="sr-only">Copy artifact</span>
      </button>
      <button
        type="button"
        onClick={onDownloadPdf}
        title="Download as PDF"
        className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Download className="h-4 w-4" />
        <span className="sr-only">Download artifact as PDF</span>
      </button>
    </div>
  );
}

/** A "⋯" menu of single-file actions (Download + Delete) for a managed file. */
function FileRowMenu({
  item,
  onDelete,
}: {
  item: ConversationFileItem;
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
          <MoreVertical className="h-4 w-4" />
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
