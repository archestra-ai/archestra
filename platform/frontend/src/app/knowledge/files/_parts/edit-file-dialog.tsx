"use client";

import { FileText } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import { ResourceAccessSection } from "@/components/resource-access-section";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
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
  const [activeSection, setActiveSection] = useState<"general" | "permissions">(
    "general",
  );

  const updateFile = useUpdateKnowledgeFile();

  // Re-seed on open so editing a second document never shows the first one's
  // values.
  useEffect(() => {
    if (!open || !file) return;
    setActiveSection("general");
    setFilename(file.filename);
    setDirectoryId(file.directoryId ?? ROOT_VALUE);
    setLabels(file.labels);
  }, [open, file]);

  const canSubmit = filename.trim().length > 0 && !updateFile.isPending;

  const handleSubmit = () => {
    if (!file) return;
    const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;
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
    <TabbedDialogShell
      open={open}
      onOpenChange={onOpenChange}
      title="Edit document"
      description="Renaming or moving a document does not re-index it; its content stays as uploaded."
      sidebarLabel={filename || "Document"}
      sidebarDescription="Document"
      sidebarIcon={<FileText className="h-4 w-4 text-muted-foreground" />}
      activeSection={activeSection}
      navItems={[
        { id: "general", label: "General" },
        { id: "permissions", label: "Permissions" },
      ]}
      onActiveSectionChange={setActiveSection}
      onSubmit={handleSubmit}
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
      <div hidden={activeSection !== "general"} className="space-y-4">
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

        <AdvancedLabelsSection
          ref={labelsRef}
          labels={labels}
          onLabelsChange={setLabels}
        />
      </div>
      <div hidden={activeSection !== "permissions"}>
        {file && (
          <ResourceAccessSection
            resource="knowledgeFile"
            id={file.id}
            standalone
          />
        )}
      </div>
    </TabbedDialogShell>
  );
}
