"use client";

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
import {
  type KnowledgeDirectory,
  type KnowledgeFile,
  useUpdateKnowledgeFile,
} from "@/lib/knowledge/knowledge-file.query";

const ROOT_VALUE = "__root__";

export function EditFileDialog({
  open,
  onOpenChange,
  file,
  directories,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file?: KnowledgeFile;
  directories: KnowledgeDirectory[];
}) {
  const [filename, setFilename] = useState("");
  const [directoryId, setDirectoryId] = useState(ROOT_VALUE);
  const [visibility, setVisibility] =
    useState<KnowledgeFileVisibility>("org-wide");
  const [teamIds, setTeamIds] = useState<string[]>([]);

  const updateFile = useUpdateKnowledgeFile();

  // Re-seed on open so editing a second document never shows the first one's
  // values.
  useEffect(() => {
    if (!open || !file) return;
    setFilename(file.filename);
    setDirectoryId(file.directoryId ?? ROOT_VALUE);
    setVisibility(file.visibility as KnowledgeFileVisibility);
    setTeamIds(file.teamIds ?? []);
  }, [open, file]);

  const canSubmit =
    filename.trim().length > 0 &&
    (visibility !== "team-scoped" || teamIds.length > 0) &&
    !updateFile.isPending;

  const handleSubmit = () => {
    if (!file) return;
    updateFile.mutate(
      {
        fileId: file.id,
        body: {
          filename: filename.trim(),
          directoryId: directoryId === ROOT_VALUE ? null : directoryId,
          visibility,
          teamIds: visibility === "team-scoped" ? teamIds : [],
        },
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit document"
      description="Renaming or moving a document does not re-index it; its content stays as uploaded."
      size="small"
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <div className="space-y-1.5">
          <Label htmlFor="edit-filename">Name</Label>
          <Input
            id="edit-filename"
            value={filename}
            onChange={(event) => setFilename(event.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="edit-directory">Directory</Label>
          <Select value={directoryId} onValueChange={setDirectoryId}>
            <SelectTrigger id="edit-directory" className="w-full">
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
      </div>

      <DialogStickyFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          <span>Cancel</span>
        </Button>
        <Button disabled={!canSubmit} onClick={handleSubmit}>
          <span>{updateFile.isPending ? "Saving…" : "Save"}</span>
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}
