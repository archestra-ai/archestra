"use client";

import { PROJECT_MEMORY_MAX_ENTRY_LENGTH } from "@archestra/shared";
import { Brain, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  useCreateProjectMemory,
  useDeleteProjectMemory,
  useProjectMemories,
  useUpdateProjectMemory,
} from "@/lib/projects/projects.query";
import { cn } from "@/lib/utils";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

/**
 * The pinned Memory entry of the project sidebar and its panel. Memories are
 * short notes the assistant saves during the project's chats (users can add,
 * edit, and delete them here too); every entry is injected into the system
 * prompt of the project's chats.
 */

/** Sentinel selection id for the pinned Memory entry (not a file ref). */
export const MEMORY_SELECTION = "__project_memory__";

/** The always-present, pinned Memory entry at the top of the file list. */
export function MemoryRow({
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
      <Brain className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        Memory
        <span className="text-muted-foreground">
          {" "}
          · remembered across chats
        </span>
      </span>
    </button>
  );
}

/**
 * The Memory surface for the pinned entry — an add composer (members only)
 * over the saved entries, newest first, each editable/deletable in place.
 * `canEdit` is real project membership (owner/shared): the admin-oversight
 * view is read-only, mirroring the backend's write gate.
 */
export function ProjectMemoryPanel({
  projectId,
  canEdit,
}: {
  projectId: string;
  canEdit: boolean;
}) {
  const { data: memories, isPending } = useProjectMemories(projectId);
  const createMemory = useCreateProjectMemory();
  const [adding, setAdding] = useState(false);

  if (isPending) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <p className="p-4 text-xs text-muted-foreground">Loading…</p>
      </div>
    );
  }

  const items = memories ?? [];

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {canEdit && (
        <div className="border-b p-3">
          {adding ? (
            <MemoryEntryEditor
              initialContent=""
              saving={createMemory.isPending}
              onCancel={() => setAdding(false)}
              onSave={async (content) => {
                const memory = await createMemory.mutateAsync({
                  id: projectId,
                  content,
                });
                if (memory) setAdding(false);
              }}
            />
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start text-muted-foreground"
              onClick={() => setAdding(true)}
            >
              <Plus className="h-4 w-4" />
              Add a memory
            </Button>
          )}
        </div>
      )}
      {items.length === 0 ? (
        <div className="flex h-32 flex-col items-center justify-center px-6 text-center text-xs text-muted-foreground">
          {canEdit
            ? "Ask the assistant to remember something in a project chat and it'll be saved here."
            : "No memories saved in this project yet."}
        </div>
      ) : (
        <ul className="divide-y">
          {items.map((memory) => (
            <MemoryEntry
              key={memory.id}
              projectId={projectId}
              memory={memory}
              canEdit={canEdit}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// === Internal ===

function MemoryEntry({
  projectId,
  memory,
  canEdit,
}: {
  projectId: string;
  memory: {
    id: string;
    content: string;
    authorName: string | null;
    createdAt: string;
  };
  canEdit: boolean;
}) {
  const updateMemory = useUpdateProjectMemory();
  const deleteMemory = useDeleteProjectMemory();
  const [editing, setEditing] = useState(false);

  return (
    <li className="group px-3 py-2">
      {editing ? (
        <MemoryEntryEditor
          initialContent={memory.content}
          saving={updateMemory.isPending}
          onCancel={() => setEditing(false)}
          onSave={async (content) => {
            const ok = await updateMemory.mutateAsync({
              id: projectId,
              memoryId: memory.id,
              content,
            });
            if (ok) setEditing(false);
          }}
        />
      ) : (
        <>
          <p className="whitespace-pre-wrap break-words text-sm">
            {memory.content}
          </p>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">
              {memory.authorName ? `${memory.authorName} · ` : ""}
              {formatRelativeTimeFromNow(memory.createdAt)}
            </span>
            {canEdit && (
              <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  title="Edit memory"
                  className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  <span className="sr-only">Edit memory</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    deleteMemory.mutate({ id: projectId, memoryId: memory.id })
                  }
                  disabled={deleteMemory.isPending}
                  title="Delete memory"
                  className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span className="sr-only">Delete memory</span>
                </button>
              </span>
            )}
          </div>
        </>
      )}
    </li>
  );
}

function MemoryEntryEditor({
  initialContent,
  saving,
  onSave,
  onCancel,
}: {
  initialContent: string;
  saving: boolean;
  onSave: (content: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialContent);
  const trimmed = draft.trim();
  const valid =
    trimmed.length > 0 && trimmed.length <= PROJECT_MEMORY_MAX_ENTRY_LENGTH;

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Something worth remembering across this project's chats…"
        rows={3}
        maxLength={PROJECT_MEMORY_MAX_ENTRY_LENGTH}
        // biome-ignore lint/a11y/noAutofocus: the editor opens on explicit user action
        autoFocus
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {draft.length}/{PROJECT_MEMORY_MAX_ENTRY_LENGTH}
        </span>
        <span className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={saving}
          >
            <X className="h-4 w-4" />
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => onSave(trimmed)}
            disabled={!valid || saving}
          >
            <Check className="h-4 w-4" />
            Save
          </Button>
        </span>
      </div>
    </div>
  );
}
