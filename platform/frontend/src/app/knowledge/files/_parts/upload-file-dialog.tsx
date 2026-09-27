// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { FileText, FolderPlus, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { DirectoryDialog } from "@/app/knowledge/files/_parts/directory-dialog";
import { AdvancedLabelsSection } from "@/components/advanced-labels-section";
import type { ProfileLabel, ProfileLabelsRef } from "@/components/agent-labels";
import {
  FileDropInput,
  fileToBase64,
  StagedFileList,
} from "@/components/files/file-drop-input";
import {
  type InitialPermissionGrant,
  InitialResourcePermissions,
} from "@/components/initial-resource-permissions";
import { TabbedDialogShell } from "@/components/tabbed-dialog-shell";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  type KnowledgeDirectory,
  useUploadKnowledgeFile,
} from "@/lib/knowledge/knowledge-file.query";
import {
  KNOWLEDGE_FILE_ACCEPT,
  KNOWLEDGE_FILE_TYPES_LABEL,
} from "@/lib/knowledge/knowledge-file-accept";

const ROOT_VALUE = "__root__";
const CREATE_DIRECTORY_VALUE = "__create_directory__";

export function UploadFileDialog({
  open,
  onOpenChange,
  directories,
  defaultDirectoryId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  directories: KnowledgeDirectory[];
  defaultDirectoryId: string | null;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [directoryId, setDirectoryId] = useState<string>(
    defaultDirectoryId ?? ROOT_VALUE,
  );
  const [initialGrants, setInitialGrants] = useState<InitialPermissionGrant[]>(
    [],
  );
  const [labels, setLabels] = useState<ProfileLabel[]>([]);
  const labelsRef = useRef<ProfileLabelsRef>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [createDirectoryOpen, setCreateDirectoryOpen] = useState(false);
  const [createdDirectory, setCreatedDirectory] =
    useState<KnowledgeDirectory>();
  const [activeSection, setActiveSection] = useState<"general" | "permissions">(
    "general",
  );

  useEffect(() => {
    if (open) setActiveSection("general");
  }, [open]);

  const upload = useUploadKnowledgeFile();
  const availableDirectories =
    createdDirectory &&
    !directories.some((directory) => directory.id === createdDirectory.id)
      ? [...directories, createdDirectory]
      : directories;

  useEffect(() => {
    if (
      createdDirectory &&
      directories.some((directory) => directory.id === createdDirectory.id)
    ) {
      setCreatedDirectory(undefined);
    }
  }, [createdDirectory, directories]);

  const reset = () => {
    setFiles([]);
    setFailures([]);
    setProgress(undefined);
    setInitialGrants([]);
    setLabels([]);
  };

  // Appends rather than replaces, so dropping a second batch adds to the first
  // instead of quietly discarding what was already staged.
  const addFiles = useCallback((incoming: File[]) => {
    setFailures([]);
    setFiles((previous) => {
      const seen = new Set(previous.map((f) => `${f.name}:${f.size}`));
      const added = incoming.filter((f) => !seen.has(`${f.name}:${f.size}`));
      return [...previous, ...added];
    });
  }, []);

  const canSubmit = files.length > 0 && !upload.isPending;

  const handleDirectoryChange = (value: string) => {
    if (value === CREATE_DIRECTORY_VALUE) {
      setCreateDirectoryOpen(true);
      return;
    }
    setDirectoryId(value);
  };

  const handleUpload = async () => {
    const finalLabels = labelsRef.current?.saveUnsavedLabel() ?? labels;
    const rejected: string[] = [];
    let done = 0;
    setProgress({ done: 0, total: files.length });

    // Sequential, and each failure is collected rather than thrown: one
    // unreadable file in a batch must not discard the ones that worked.
    for (const file of files) {
      try {
        await upload.mutateAsync({
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          content: await fileToBase64(file),
          directoryId: directoryId === ROOT_VALUE ? null : directoryId,
          initialGrants: initialGrants.map(({ subject, actions }) => ({
            subject,
            actions,
          })),
          labels: finalLabels,
        });
      } catch {
        rejected.push(file.name);
      }
      done += 1;
      setProgress({ done, total: files.length });
    }

    if (rejected.length > 0) {
      setFailures(rejected);
      setFiles([]);
      setProgress(undefined);
      return;
    }
    reset();
    onOpenChange(false);
  };

  return (
    <>
      <TabbedDialogShell
        open={open}
        onOpenChange={onOpenChange}
        title="Upload documents"
        description="PDF, Word, Markdown, CSV, JSON or plain text. Documents become searchable once you add them to a knowledge base."
        sidebarLabel="New documents"
        sidebarDescription="Knowledge files"
        sidebarIcon={<FileText className="h-4 w-4 text-muted-foreground" />}
        activeSection={activeSection}
        navItems={[
          { id: "general", label: "General" },
          { id: "permissions", label: "Permissions" },
        ]}
        onActiveSectionChange={setActiveSection}
        onSubmit={() => void handleUpload()}
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
              <Upload className="mr-1 h-4 w-4" />
              <span>
                {progress
                  ? `Uploading ${progress.done}/${progress.total}…`
                  : files.length > 1
                    ? `Upload ${files.length} documents`
                    : "Upload"}
              </span>
            </Button>
          </>
        }
      >
        <div
          hidden={activeSection !== "general"}
          className="space-y-4"
          data-testid="upload-file-general"
        >
          <FileDropInput
            accept={KNOWLEDGE_FILE_ACCEPT}
            typesLabel={KNOWLEDGE_FILE_TYPES_LABEL}
            onFiles={addFiles}
          />

          <StagedFileList
            files={files}
            onRemove={(file) =>
              setFiles((previous) => previous.filter((f) => f !== file))
            }
          />

          <div className="space-y-1.5">
            <Label htmlFor="upload-directory">Directory</Label>
            <Select value={directoryId} onValueChange={handleDirectoryChange}>
              <SelectTrigger id="upload-directory" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ROOT_VALUE}>No directory</SelectItem>
                {availableDirectories.map((directory) => (
                  <SelectItem key={directory.id} value={directory.id}>
                    {directory.name}
                  </SelectItem>
                ))}
                <SelectSeparator />
                <SelectItem
                  value={CREATE_DIRECTORY_VALUE}
                  icon={<FolderPlus className="h-4 w-4" />}
                >
                  Create directory…
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <AdvancedLabelsSection
            ref={labelsRef}
            labels={labels}
            onLabelsChange={setLabels}
          />

          {failures.length > 0 && (
            <InlineNotice variant="error">
              <span className="font-medium">
                Could not read {failures.length}{" "}
                {failures.length === 1 ? "document" : "documents"}
              </span>
              <InlineNoticeText>
                {failures.join(", ")}. A scanned PDF with no text layer has
                nothing to index — run OCR over it first.
              </InlineNoticeText>
            </InlineNotice>
          )}
        </div>
        <div hidden={activeSection !== "permissions"}>
          <InitialResourcePermissions
            resource="knowledgeFile"
            grants={initialGrants}
            onChange={setInitialGrants}
            standalone
          />
        </div>
      </TabbedDialogShell>
      <DirectoryDialog
        open={createDirectoryOpen}
        onOpenChange={setCreateDirectoryOpen}
        onCreated={(directory) => {
          setCreatedDirectory(directory);
          setDirectoryId(directory.id);
        }}
      />
    </>
  );
}
