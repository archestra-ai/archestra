"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { StandardFormDialog } from "@/components/standard-dialog";
import { Button } from "@/components/ui/button";
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
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  // The permissions block keeps its edits in its own form. This dialog's
  // Save is the only Save on screen, so it commits them too.
  const permissionsSave = useRef<(() => Promise<void>) | null>(null);
  const registerPermissionsSave = useCallback(
    (save: (() => Promise<void>) | null) => {
      permissionsSave.current = save;
    },
    [],
  );
  const [permissionsDirty, setPermissionsDirty] = useState(false);

  const updateFile = useUpdateKnowledgeFile();

  // Re-seed on open so editing a second document never shows the first one's
  // values.
  useEffect(() => {
    if (!open || !file) return;
    setFilename(file.filename);
    setDirectoryId(file.directoryId ?? ROOT_VALUE);
    setLabels(file.labels);
  }, [open, file]);

  const canSubmit = filename.trim().length > 0 && !updateFile.isPending;

  const handleSubmit = async () => {
    if (!file) return;
    const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;
    await permissionsSave.current?.();
    updateFile.mutate(
      {
        fileId: file.id,
        body: {
          filename: filename.trim(),
          directoryId: directoryId === ROOT_VALUE ? null : directoryId,
          labels: finalLabels,
        },
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit document"
      description="Renaming or moving a document does not re-index it; its content stays as uploaded."
      isDirty={permissionsDirty}
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
      bodyClassName="space-y-4"
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {updateFile.isPending ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
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

      {file && (
        <ResourceAccessSection
          resource="knowledgeFile"
          id={file.id}
          registerSave={registerPermissionsSave}
          onDirtyChange={setPermissionsDirty}
        />
      )}
      <AdvancedLabelsSection
        ref={labelsRef}
        labels={labels}
        onLabelsChange={setLabels}
      />
    </StandardFormDialog>
  );
}
