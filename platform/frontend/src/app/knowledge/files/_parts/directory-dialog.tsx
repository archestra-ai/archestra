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
  type KnowledgeDirectory,
  useCreateKnowledgeDirectory,
  useUpdateKnowledgeDirectory,
} from "@/lib/knowledge/knowledge-file.query";

export function DirectoryDialog({
  open,
  onOpenChange,
  directory,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absent = create. */
  directory?: KnowledgeDirectory;
  onCreated?: (directory: KnowledgeDirectory) => void;
}) {
  const [name, setName] = useState("");
  const [visibility, setVisibility] =
    useState<KnowledgeFileVisibility>("org-wide");
  const [teamIds, setTeamIds] = useState<string[]>([]);

  const createDirectory = useCreateKnowledgeDirectory();
  const updateDirectory = useUpdateKnowledgeDirectory();

  // Re-seed when the dialog opens so editing a second directory does not show
  // the first one's values.
  useEffect(() => {
    if (!open) return;
    setName(directory?.name ?? "");
    setVisibility(
      (directory?.visibility as KnowledgeFileVisibility) ?? "org-wide",
    );
    setTeamIds(directory?.teamIds ?? []);
  }, [open, directory]);

  const isPending = createDirectory.isPending || updateDirectory.isPending;
  const canSubmit =
    name.trim().length > 0 &&
    (visibility !== "team-scoped" || teamIds.length > 0) &&
    !isPending;

  const handleSubmit = () => {
    const body = {
      name: name.trim(),
      visibility,
      teamIds: visibility === "team-scoped" ? teamIds : [],
    };
    const onSuccess = () => onOpenChange(false);

    if (directory) {
      updateDirectory.mutate(
        { directoryId: directory.id, body },
        { onSuccess },
      );
      return;
    }
    createDirectory.mutate(body, {
      onSuccess: (createdDirectory) => {
        if (createdDirectory) onCreated?.(createdDirectory);
        onSuccess();
      },
    });
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={directory ? "Edit directory" : "New directory"}
      description="Directories organise documents and set the default audience for files added to them."
      size="small"
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <div className="space-y-1.5">
          <Label htmlFor="directory-name">Name</Label>
          <Input
            id="directory-name"
            placeholder="Vendor contracts"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <FileVisibilitySelector
          visibility={visibility}
          onVisibilityChange={setVisibility}
          teamIds={teamIds}
          onTeamIdsChange={setTeamIds}
          label="Default audience"
          description="Applied to files uploaded here. Changing it does not re-open documents already indexed from this directory."
        />
      </div>

      <DialogStickyFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          <span>Cancel</span>
        </Button>
        <Button disabled={!canSubmit} onClick={handleSubmit}>
          <span>{isPending ? "Saving…" : directory ? "Save" : "Create"}</span>
        </Button>
      </DialogStickyFooter>
    </FormDialog>
  );
}
