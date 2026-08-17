"use client";

import { FileText } from "lucide-react";
import { useEffect, useState } from "react";
import {
  FileVisibilitySelector,
  type KnowledgeFileVisibility,
} from "@/app/knowledge/files/_parts/file-visibility-selector";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogStickyFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SingleSelectCombobox } from "@/components/ui/single-select-combobox";
import { useKnowledgeBases } from "@/lib/knowledge/knowledge-base.query";
import {
  useKnowledgeDirectories,
  usePromoteAttachmentToKnowledgeFile,
} from "@/lib/knowledge/knowledge-file.query";

const ROOT_VALUE = "__root__";
const NO_KNOWLEDGE_BASE = "__none__";

/** A chat attachment to copy: its id and the name to propose for the copy. */
export type SavableAttachment = { id: string; name: string };

/**
 * Saves one or more files attached to a chat into the knowledge repository.
 *
 * A chat attachment lives and dies with its conversation; this copies the bytes
 * out so the document persists and can be indexed. Deliberately the same
 * controls as the repository's own upload dialog — directory, visibility — so a
 * file lands with the same choices however it got here. Renaming is offered
 * only for a single file, where there is one name to mean.
 */
export function SaveToKnowledgeDialog({
  open,
  onOpenChange,
  attachments,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  attachments: SavableAttachment[];
}) {
  const single = attachments.length === 1 ? attachments[0] : null;

  const [filename, setFilename] = useState(single?.name ?? "");
  const [directoryId, setDirectoryId] = useState(ROOT_VALUE);
  const [visibility, setVisibility] =
    useState<KnowledgeFileVisibility>("org-wide");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [knowledgeBaseId, setKnowledgeBaseId] = useState(NO_KNOWLEDGE_BASE);
  const [failures, setFailures] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number }>();

  const { data: directories = [] } = useKnowledgeDirectories();
  const { data: knowledgeBases } = useKnowledgeBases();
  const promote = usePromoteAttachmentToKnowledgeFile();

  // Re-seed on open so saving a second file never shows the first one's name.
  useEffect(() => {
    if (!open) return;
    setFilename(single?.name ?? "");
    setDirectoryId(ROOT_VALUE);
    setVisibility("org-wide");
    setTeamIds([]);
    setKnowledgeBaseId(NO_KNOWLEDGE_BASE);
    setFailures([]);
    setProgress(undefined);
  }, [open, single?.name]);

  const canSubmit =
    attachments.length > 0 &&
    (!single || filename.trim().length > 0) &&
    (visibility !== "team-scoped" || teamIds.length > 0) &&
    !promote.isPending;

  const handleSubmit = async () => {
    const rejected: string[] = [];
    let done = 0;
    setProgress({ done: 0, total: attachments.length });

    // Sequential, and each failure is collected rather than thrown: one file
    // the repository cannot read (or a name already taken) must not discard
    // the ones that saved. Mirrors the repository's own bulk upload.
    for (const attachment of attachments) {
      try {
        await promote.mutateAsync({
          attachmentId: attachment.id,
          ...(single ? { filename: filename.trim() } : {}),
          directoryId: directoryId === ROOT_VALUE ? null : directoryId,
          visibility,
          teamIds: visibility === "team-scoped" ? teamIds : [],
          ...(knowledgeBaseId === NO_KNOWLEDGE_BASE ? {} : { knowledgeBaseId }),
        });
      } catch {
        rejected.push(attachment.name);
      }
      done += 1;
      setProgress({ done, total: attachments.length });
    }

    if (rejected.length > 0) {
      setFailures(rejected);
      setProgress(undefined);
      return;
    }
    onOpenChange(false);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={single ? "Save to knowledge" : `Save ${attachments.length} files`}
      description="Keeps a copy in the knowledge repository, where it outlives this conversation."
      size="small"
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {single ? (
          <div className="space-y-1.5">
            <Label htmlFor="save-filename">Name</Label>
            <Input
              id="save-filename"
              value={filename}
              onChange={(event) => setFilename(event.target.value)}
            />
          </div>
        ) : (
          <ul className="max-h-32 space-y-1 overflow-y-auto rounded-md border p-2">
            {attachments.map((attachment) => (
              <li
                key={attachment.id}
                className="flex items-center gap-2 px-1 py-1 text-sm"
              >
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  {attachment.name}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="save-directory">Directory</Label>
          <Select value={directoryId} onValueChange={setDirectoryId}>
            <SelectTrigger id="save-directory" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ROOT_VALUE}>No directory</SelectItem>
              {directories.map((directory) => (
                <SelectItem key={directory.id} value={directory.id}>
                  {directory.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <FileVisibilitySelector
          visibility={visibility}
          onVisibilityChange={setVisibility}
          teamIds={teamIds}
          onTeamIdsChange={setTeamIds}
        />

        <div className="space-y-1.5">
          <Label htmlFor="save-knowledge-base">Knowledge base</Label>
          {/* Optional, and empty by default: saving a document and making it
              retrievable by agents are separate decisions, and the second one
              is the one that changes who can see it in an answer. */}
          <SingleSelectCombobox
            options={[
              { value: NO_KNOWLEDGE_BASE, label: "Don't index yet" },
              ...(knowledgeBases ?? []).map((knowledgeBase) => ({
                value: knowledgeBase.id,
                label: knowledgeBase.name,
              })),
            ]}
            value={knowledgeBaseId}
            onChange={setKnowledgeBaseId}
            placeholder="Don't index yet"
            searchPlaceholder="Search knowledge bases"
            emptyMessage="No knowledge bases yet"
            className="w-full"
          />
        </div>

        {failures.length > 0 && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="font-medium text-destructive text-sm">
              Could not save {failures.length}{" "}
              {failures.length === 1 ? "file" : "files"}
            </p>
            <p className="mt-1 text-muted-foreground text-xs">
              {failures.join(", ")}. A file the repository cannot read — a
              scanned PDF with no text layer, or an image — has nothing to
              index. A name already in use needs a different one.
            </p>
          </div>
        )}
      </div>

      <DialogStickyFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          <span>Cancel</span>
        </Button>
        <Button disabled={!canSubmit} onClick={() => void handleSubmit()}>
          <span>
            {progress
              ? `Saving ${progress.done}/${progress.total}…`
              : single
                ? "Save"
                : `Save ${attachments.length} files`}
          </span>
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}
