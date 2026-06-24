"use client";

import { PROJECT_INSTRUCTIONS_FILENAME } from "@archestra/shared";
import { Check, Copy, Download, File as FileIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ConversationArtifactPanel } from "@/components/chat/conversation-artifact";
import { FileSection } from "@/components/chat/file-list-section";
import { FilePreview } from "@/components/chat/file-preview";
import {
  INSTRUCTIONS_SELECTION,
  InstructionsRow,
  ProjectInstructionsPanel,
} from "@/components/chat/project-instructions";
import { useConversationFiles } from "@/lib/chat/chat.query";
import { assembleFileSections } from "@/lib/chat/conversation-files";
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

  // In a project chat, instructions.md is surfaced only as the pinned entry —
  // keep it out of the ordinary project file list. Its presence drives the row.
  const hasInstructions = sections.projectFiles.some(
    (f) => f.name === PROJECT_INSTRUCTIONS_FILENAME,
  );
  const projectFiles = sections.projectFiles.filter(
    (f) => f.name !== PROJECT_INSTRUCTIONS_FILENAME,
  );
  const hasArtifact = !!artifact && artifact.trim().length > 0;
  // Default to previewing the artifact when one exists as the panel opens.
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    hasArtifact ? "artifact" : null,
  );

  // This chat's own outputs and the project's files are one group ("Results");
  // only attachments stand apart.
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

  // The Results header only earns its place when attachments sit beside it; a
  // lone group needs no label to tell it apart.
  const showHeaders = results.length > 0 && attachments.length > 0;

  // download_file outputs only (the artifact has its own default handling).
  const generatedFileIds = generated
    .filter((f) => f.source === "generated")
    .map((f) => f.id);
  const newestGeneratedId = generatedFileIds.at(-1);
  const generatedKey = generatedFileIds.join("|");
  const filesLoaded = files !== undefined;

  // Clear the preview if the selected file disappears (e.g. artifact cleared).
  // Depend on a stable boolean, not the freshly-built `all` array each render.
  // The instructions sentinel is never a file, so it must not count as missing.
  const selectedMissing =
    selectedId !== null && !instructionsSelected && selected === null;
  useEffect(() => {
    if (selectedMissing) {
      setSelectedId(null);
    }
  }, [selectedMissing]);

  // Default the preview when nothing is selected: the artifact first, otherwise
  // the newest generated file. Covers panel open, files loading in, and a
  // cleared selection. A file the user actively picked keeps `selectedId`
  // non-null, so this never overrides it.
  useEffect(() => {
    if (selectedId !== null) return;
    if (hasArtifact) {
      setSelectedId("artifact");
    } else if (newestGeneratedId) {
      setSelectedId(newestGeneratedId);
    }
  }, [selectedId, hasArtifact, newestGeneratedId]);

  // Follow the latest produced output: when the artifact is (re)written switch
  // back to it, when a download_file output is created switch to that file — the
  // same "pop" the artifact does. The first loaded set is captured as a baseline
  // so existing files/artifact don't hijack the view when the panel opens.
  const prevArtifactRef = useRef<string | null | undefined>(undefined);
  const seenGeneratedRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!filesLoaded) return;
    const ids = generatedKey ? generatedKey.split("|") : [];
    const prevGenerated = seenGeneratedRef.current;
    const prevArtifact = prevArtifactRef.current;
    seenGeneratedRef.current = new Set(ids);
    prevArtifactRef.current = artifact;
    if (prevGenerated === null) return; // baseline only — default handles open
    // Don't yank the view away from the instructions editor (and its unsaved
    // draft) when a new output lands while the owner is editing.
    if (instructionsSelectedRef.current) return;

    if (hasArtifact && artifact !== prevArtifact) {
      setSelectedId("artifact");
      return;
    }
    const fresh = ids.filter((id) => !prevGenerated.has(id));
    if (fresh.length > 0) {
      setSelectedId(fresh[fresh.length - 1]);
    }
  }, [filesLoaded, generatedKey, artifact, hasArtifact]);

  // The artifact is rendered once and kept mounted whenever it exists, so its
  // row's "Download as PDF" button has rendered content to print even when the
  // artifact isn't the open file. It's shown in the preview slot when selected,
  // hidden otherwise.
  const artifactRef = useRef<HTMLDivElement>(null);
  const handleDownloadArtifactPdf = () =>
    printMarkdownElementAsPdf(artifactRef.current, "Artifact");
  const artifactSelected = selected?.source === "artifact";
  const previewing = selected !== null || instructionsSelected;

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

  // List always stays visible; the selected file previews below it in the same
  // sidebar (stacked master-detail). When nothing is selected the list fills the
  // panel; once a file is open the list is capped and the preview takes the rest.
  return (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          "overflow-y-auto px-3 py-3",
          previewing ? "max-h-[45%] shrink-0 border-b" : "flex-1",
        )}
      >
        {showInstructions && (
          <InstructionsRow
            selected={instructionsSelected}
            hasContent={hasInstructions}
            onSelect={() => setSelectedId(INSTRUCTIONS_SELECTION)}
          />
        )}
        <FileSection
          title={showHeaders ? "Results" : undefined}
          items={results}
          selectedId={selectedId}
          onSelect={setSelectedId}
          renderActions={(item) =>
            item.source === "artifact" ? (
              <ArtifactRowActions
                content={artifact ?? ""}
                onDownloadPdf={handleDownloadArtifactPdf}
              />
            ) : null
          }
        />
        <FileSection
          title={showHeaders ? "Attachments" : undefined}
          items={attachments}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      </div>

      {hasArtifact && (
        <div
          ref={artifactRef}
          className={cn(
            artifactSelected ? "min-h-0 flex-1 overflow-auto" : "hidden",
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

      {selected && !artifactSelected && (
        <FilePreview file={selected} onClose={onClose} />
      )}

      {instructionsSelected && projectId && (
        <ProjectInstructionsPanel
          projectId={projectId}
          isOwner={isProjectOwner}
          onClose={() => setSelectedId(null)}
        />
      )}
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
