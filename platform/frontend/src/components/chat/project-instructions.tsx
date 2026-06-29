"use client";

import {
  PROJECT_INSTRUCTIONS_FILENAME,
  PROJECT_INSTRUCTIONS_MAX_LENGTH,
} from "@archestra/shared";
import { FileText } from "lucide-react";
import { useState } from "react";
import { ConversationArtifactPanel } from "@/components/chat/conversation-artifact";
import { PlainTextEditor } from "@/components/chat/plain-text-editor";
import {
  useProjectInstructions,
  useSetProjectInstructions,
} from "@/lib/projects/projects.query";
import { cn } from "@/lib/utils";

/**
 * The pinned project-instructions entry and its editor, shared by the project
 * Files sidebar and a project chat's Files panel so both surfaces treat
 * `instructions.md` identically (a pinned, owner-editable special file).
 */

/** Sentinel selection id for the pinned instructions entry (not a file ref). */
export const INSTRUCTIONS_SELECTION = "__project_instructions__";

/** The always-present, pinned instructions entry at the top of the file list. */
export function InstructionsRow({
  selected = false,
  onSelect,
}: {
  selected?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
        selected
          ? "bg-accent font-medium text-accent-foreground"
          : "hover:bg-muted/50",
      )}
    >
      {/* Single line, same muted-icon treatment as a regular .md file row — the
          instructions entry looks like the rest of the list, only pinned and
          with an inline description after the filename. */}
      <FileText
        className="h-5 w-5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">
        {PROJECT_INSTRUCTIONS_FILENAME}
        <span className="text-muted-foreground">
          {" "}
          · guidance for every chat
        </span>
      </span>
    </button>
  );
}

/**
 * The instructions surface for the pinned entry — the body only, mirroring
 * {@link FilePreview}: the editor when `editing`, the rendered read view
 * otherwise. The caller owns the `editing` flag and renders the Edit toggle in
 * the file detail header's action row (so it sits with the other row actions);
 * `onExitEdit` fires when the editor saves or cancels.
 */
export function ProjectInstructionsPanel({
  projectId,
  isOwner,
  editing,
  onExitEdit,
}: {
  projectId: string;
  isOwner: boolean;
  editing: boolean;
  onExitEdit: () => void;
}) {
  const { data, isPending } = useProjectInstructions(projectId);
  const setInstructions = useSetProjectInstructions();
  const content = data?.content ?? "";

  if (isPending) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <p className="p-4 text-xs text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (isOwner && editing) {
    return (
      <InstructionsEditor
        initialContent={content}
        saving={setInstructions.isPending}
        onCancel={onExitEdit}
        onSave={async (value) => {
          const ok = await setInstructions.mutateAsync({
            id: projectId,
            content: value,
          });
          if (ok) onExitEdit();
        }}
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {content.trim() ? (
        <ConversationArtifactPanel
          artifact={content}
          isOpen
          onToggle={() => {}}
          embedded
          hideHeader
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center px-6 text-center text-xs text-muted-foreground">
          {isOwner
            ? "No instructions yet."
            : "The project owner hasn't added any instructions."}
        </div>
      )}
    </div>
  );
}

/**
 * The textarea editor. Mounts only once the content has loaded, so the draft is
 * seeded directly from `initialContent`. Save persists and (via onSave)
 * collapses the panel; Cancel just collapses.
 */
function InstructionsEditor({
  initialContent,
  saving,
  onSave,
  onCancel,
}: {
  initialContent: string;
  saving: boolean;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialContent);

  return (
    <PlainTextEditor
      value={draft}
      onChange={setDraft}
      // Instructions are bounded by character count (they go into every prompt).
      count={draft.length}
      max={PROJECT_INSTRUCTIONS_MAX_LENGTH}
      saving={saving}
      onSave={() => onSave(draft)}
      onCancel={onCancel}
      placeholder="Instructions that apply to every chat in this project…"
    />
  );
}
