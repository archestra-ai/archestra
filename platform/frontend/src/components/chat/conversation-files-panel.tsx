"use client";

import {
  isEditableTextFile,
  PROJECT_INSTRUCTIONS_FILENAME,
} from "@archestra/shared";
import {
  Check,
  Copy,
  Download,
  File as FileIcon,
  Pencil,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ConversationArtifactPanel } from "@/components/chat/conversation-artifact";
import { FileDetailHeader } from "@/components/chat/file-detail-header";
import { FilePreview } from "@/components/chat/file-preview";
import {
  INSTRUCTIONS_SELECTION,
  InstructionsRow,
  ProjectInstructionsPanel,
} from "@/components/chat/project-instructions";
import { SelectableFileList } from "@/components/chat/selectable-file-list";
import { FileDropZone } from "@/components/files/file-drop-zone";
import {
  useBulkDeleteConversationFiles,
  useConversationFiles,
  useDeleteConversationFile,
} from "@/lib/chat/chat.query";
import {
  ATTACHMENTS_SECTION,
  assembleFileSections,
  type ConversationFileItem,
  persistentFilesSection,
} from "@/lib/chat/conversation-files";
import { printMarkdownElementAsPdf } from "@/lib/chat/print-markdown";
import { useFileDeletion } from "@/lib/chat/use-file-deletion";
import {
  useProject,
  useUploadProjectFiles,
} from "@/lib/projects/projects.query";
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
  // A project chat's files belong to the project, so dropping onto this panel
  // uploads to the project (same destination as the project page). Non-project
  // chats get no drop zone — there's no project, and we don't add chat
  // attachments via drag-and-drop. Hook is called unconditionally (rules of
  // hooks); it only issues a request when a drop actually fires.
  const uploadProjectFiles = useUploadProjectFiles(projectId ?? "");
  // Editing instructions requires manage rights; in a chat the participant is
  // the owner (a shared member sees them read-only).
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

  // Default to previewing the artifact when one exists as the panel opens.
  // Opening a file shows it below the list (split); `expanded` fills the panel.
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    hasArtifact ? "artifact" : null,
  );
  const [expanded, setExpanded] = useState(false);

  // This chat's own outputs and the project's files are one persistent group —
  // labeled "Project files" in a project chat, "Chat files" otherwise. Uploaded
  // attachments stand apart, since they're transient inputs rather than saved
  // work products.
  const results = [...generated, ...projectFiles];
  const all = [...results, ...attachments];
  const selected = all.find((f) => f.id === selectedId) ?? null;

  // The pinned instructions entry only exists in a project chat. Its sentinel
  // selection is not a file, so it must be excluded from the "selected file"
  // bookkeeping below.
  const showInstructions = projectId != null;
  const instructionsSelected =
    showInstructions && selectedId === INSTRUCTIONS_SELECTION;
  const instructionsSelectedRef = useRef(false);
  instructionsSelectedRef.current = instructionsSelected;

  // The selected file's in-place editor is open. Lifted here (not inside
  // FilePreview) so the Edit toggle can live in the action row next to
  // Download/Delete. A ref mirrors it so the "follow latest output" effect below
  // can avoid yanking the view (and an unsaved draft) away when a new file lands
  // during a run — the same guard the instructions editor gets.
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(false);
  editingRef.current = editing;
  // Only .md/.txt files the viewer can manage are editable; attachments and the
  // in-memory artifact never are. `canManageFiles` is the same gate as Delete.
  const selectedEditable =
    selected != null &&
    canManageFiles &&
    selected.source !== "attachment" &&
    selected.source !== "artifact" &&
    isEditableTextFile({
      filename: selected.name,
      mimeType: selected.mimeType,
    });

  // Something is open (file, artifact, or the pinned instructions) → show the
  // preview. Split by default; `expanded` hides the list and fills the panel.
  const previewing = selected !== null || instructionsSelected;

  const openFile = (id: string) => {
    setSelectedId(id);
    // Everything (files and instructions) opens in the read view; editing is
    // entered explicitly via the Edit affordance in the action row.
    setEditing(false);
    setExpanded(false);
  };
  const collapse = () => setExpanded(false);
  const deselect = () => {
    setSelectedId(null);
    setEditing(false);
    setExpanded(false);
  };

  // download_file outputs only (the artifact has its own default handling).
  const generatedFileIds = generated
    .filter((f) => f.source === "generated")
    .map((f) => f.id);
  const generatedKey = generatedFileIds.join("|");
  const filesLoaded = files !== undefined;

  // Clear the preview if the selected file disappears (e.g. artifact cleared or
  // the open file was deleted) and fall back to the list. The instructions
  // sentinel is never a file, so it must not count as missing.
  const selectedMissing =
    selectedId !== null && !instructionsSelected && selected === null;
  useEffect(() => {
    if (selectedMissing) {
      setSelectedId(null);
      setEditing(false);
      setExpanded(false);
    }
  }, [selectedMissing]);

  // Follow the latest produced output: when the artifact is (re)written switch
  // back to it, when a download_file output is created switch to that file. It
  // previews in the split (collapsing any expanded view) rather than taking
  // over the panel. The first loaded set is captured as a baseline so existing
  // files don't hijack the view when the panel opens.
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
      if (!hasArtifact && ids.length > 0) setSelectedId(ids[ids.length - 1]);
      return; // baseline only
    }
    // Don't yank the view away from the instructions editor (and its unsaved
    // draft) when a new output lands while the owner is editing.
    if (instructionsSelectedRef.current) return;
    // Same for an open file editor with an unsaved draft.
    if (editingRef.current) return;

    if (hasArtifact && artifact !== prevArtifact) {
      setSelectedId("artifact");
      setExpanded(false);
      return;
    }
    const fresh = ids.filter((id) => !prevGenerated.has(id));
    if (fresh.length > 0) {
      setSelectedId(fresh[fresh.length - 1]);
      setExpanded(false);
    }
  }, [filesLoaded, generatedKey, artifact, hasArtifact]);

  // The artifact is rendered once and kept mounted whenever it exists, so the
  // row / detail-header "Download as PDF" button has rendered content to print
  // even when the artifact isn't the open file. It fills the preview area when
  // selected, and is hidden otherwise.
  const artifactRef = useRef<HTMLDivElement>(null);
  const handleDownloadArtifactPdf = () =>
    printMarkdownElementAsPdf(artifactRef.current, "Artifact");
  const artifactSelected = selected?.source === "artifact";

  // Shared confirm + delete flow. The chat surface keeps its own delete hooks
  // (which own the toast + cache invalidation) and routes each file by source.
  const deleteFile = useDeleteConversationFile(conversationId);
  const bulkDelete = useBulkDeleteConversationFiles(conversationId);
  const { requestDelete, dialog: deleteDialog } =
    useFileDeletion<ConversationFileItem>({
      deleteItems: async (items) => {
        if (items.length === 1) {
          try {
            await deleteFile.mutateAsync(items[0]);
            return { failedIds: [] };
          } catch {
            return { failedIds: [items[0].id] };
          }
        }
        return bulkDelete.mutateAsync(items);
      },
      describe: (items) =>
        // A project file — or a file generated in a project chat — is shared, so
        // deleting it removes it for everyone with access to the project.
        items.some(
          (i) =>
            i.source === "project" ||
            (i.source === "generated" && projectId != null),
        )
          ? "This file is part of the project and will be removed for everyone with access to it. This can't be undone."
          : "This can't be undone.",
    });

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
    ? PROJECT_INSTRUCTIONS_FILENAME
    : (selected?.name ?? "");

  const panelBody = (
    <div className="flex h-full flex-col">
      {/* The list fills the panel when nothing is open, is capped above the
          preview in the split, and is hidden when the preview is expanded.
          Kept mounted so an in-progress multi-selection survives previewing. */}
      <div
        className={cn(
          "flex flex-col",
          previewing
            ? expanded
              ? "hidden"
              : "max-h-[45%] shrink-0 overflow-hidden border-b"
            : "min-h-0 flex-1",
        )}
      >
        <SelectableFileList<ConversationFileItem>
          sections={[
            { ...persistentFilesSection(projectId), items: results },
            { ...ATTACHMENTS_SECTION, items: attachments },
          ]}
          canManage={canManageFiles}
          selectedId={selectedId}
          onOpen={openFile}
          onRequestDelete={requestDelete}
          leading={
            showInstructions ? (
              <InstructionsRow
                selected={instructionsSelected}
                onSelect={() => openFile(INSTRUCTIONS_SELECTION)}
              />
            ) : undefined
          }
          renderItemActions={(item) =>
            item.source === "artifact" ? (
              <ArtifactRowActions
                content={artifact ?? ""}
                onDownloadPdf={handleDownloadArtifactPdf}
              />
            ) : undefined
          }
        />
      </div>

      {previewing && (
        <FileDetailHeader
          title={detailName}
          expanded={expanded}
          onExpand={() => setExpanded(true)}
          onCollapse={collapse}
        >
          {artifactSelected ? (
            <ArtifactRowActions
              content={artifact ?? ""}
              onDownloadPdf={handleDownloadArtifactPdf}
            />
          ) : instructionsSelected ? (
            isProjectOwner &&
            !editing && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                title="Edit instructions"
                className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Pencil className="h-4 w-4" />
                <span className="sr-only">Edit instructions</span>
              </button>
            )
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
                {selectedEditable && !editing && (
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    title={`Edit ${selected.name}`}
                    className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Pencil className="h-4 w-4" />
                    <span className="sr-only">Edit {selected.name}</span>
                  </button>
                )}
                {canManageFiles && (
                  <button
                    type="button"
                    onClick={() =>
                      requestDelete([selected], (failedIds) => {
                        if (!failedIds.includes(selected.id)) deselect();
                      })
                    }
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
        </FileDetailHeader>
      )}

      {previewing && !artifactSelected && instructionsSelected && projectId && (
        <ProjectInstructionsPanel
          projectId={projectId}
          isOwner={isProjectOwner}
          editing={editing}
          onExitEdit={() => setEditing(false)}
        />
      )}

      {previewing && !artifactSelected && !instructionsSelected && selected && (
        <FilePreview
          // Per-file key: drop any editor state when the previewed file changes.
          key={selected.id}
          file={selected}
          onClose={deselect}
          fileId={selected.id}
          editing={editing && selectedEditable}
          onExitEdit={() => setEditing(false)}
        />
      )}

      {hasArtifact && (
        <div
          ref={artifactRef}
          className={cn(
            previewing && artifactSelected
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

      {deleteDialog}
    </div>
  );

  // No project = no drop target (the composer still handles chat attachments).
  if (projectId == null) return panelBody;
  return (
    <FileDropZone
      onDropFiles={(droppedFiles) => uploadProjectFiles.mutate(droppedFiles)}
      uploading={uploadProjectFiles.isPending}
      className="h-full"
    >
      {panelBody}
    </FileDropZone>
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
