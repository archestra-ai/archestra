"use client";

import {
  PROJECT_INSTRUCTIONS_FILENAME,
  PROJECT_INSTRUCTIONS_MAX_LENGTH,
} from "@archestra/shared";
import { FileText } from "lucide-react";
import { useState } from "react";
import { ConversationArtifactPanel } from "@/components/chat/conversation-artifact";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
 * The instructions surface for the pinned entry. The owner lands straight in the
 * editor (no repeated filename header, no Edit button); non-owners get a
 * read-only rendered view with a Close.
 */
export function ProjectInstructionsPanel({
  projectId,
  isOwner,
  onClose,
}: {
  projectId: string;
  isOwner: boolean;
  onClose: () => void;
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

  if (isOwner) {
    return (
      <InstructionsEditor
        initialContent={content}
        saving={setInstructions.isPending}
        onCancel={onClose}
        onSave={async (value) => {
          const ok = await setInstructions.mutateAsync({
            id: projectId,
            content: value,
          });
          if (ok) onClose();
        }}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-end border-b px-3 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={onClose}
        >
          Close
        </Button>
      </div>
      {content.trim() ? (
        <ConversationArtifactPanel
          artifact={content}
          isOpen
          onToggle={onClose}
          embedded
          hideHeader
        />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center text-xs text-muted-foreground">
          The project owner hasn't added any instructions.
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
  const overLimit = draft.length > PROJECT_INSTRUCTIONS_MAX_LENGTH;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <Textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Instructions that apply to every chat in this project…"
        className="min-h-40 flex-1 resize-none font-mono text-xs"
        autoFocus
      />
      <div className="flex items-center justify-between">
        <span
          className={cn(
            "text-[11px]",
            overLimit ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {draft.length.toLocaleString()} /{" "}
          {PROJECT_INSTRUCTIONS_MAX_LENGTH.toLocaleString()}
        </span>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => onSave(draft)}
            disabled={saving || overLimit}
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
