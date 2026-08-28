"use client";

import { FolderPlus, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DirectoryDialog } from "@/app/knowledge/files/_parts/directory-dialog";
import {
  FileVisibilitySelector,
  type KnowledgeFileVisibility,
} from "@/app/knowledge/files/_parts/file-visibility-selector";
import {
  FileDropInput,
  fileToBase64,
  StagedFileList,
} from "@/components/files/file-drop-input";
import { FormDialog } from "@/components/form-dialog";
import { Button } from "@/components/ui/button";
import { DialogStickyFooter } from "@/components/ui/dialog";
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
  const [visibility, setVisibility] =
    useState<KnowledgeFileVisibility>("org-wide");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [failures, setFailures] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number }>();
  const [createDirectoryOpen, setCreateDirectoryOpen] = useState(false);
  const [createdDirectory, setCreatedDirectory] =
    useState<KnowledgeDirectory>();

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
    setVisibility("org-wide");
    setTeamIds([]);
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

  const canSubmit =
    files.length > 0 &&
    (visibility !== "team-scoped" || teamIds.length > 0) &&
    !upload.isPending;

  const handleDirectoryChange = (value: string) => {
    if (value === CREATE_DIRECTORY_VALUE) {
      setCreateDirectoryOpen(true);
      return;
    }
    setDirectoryId(value);
  };

  const handleUpload = async () => {
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
          visibility,
          teamIds: visibility === "team-scoped" ? teamIds : [],
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
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Upload documents"
        description="PDF, Word, Markdown, CSV, JSON or plain text. Documents become searchable once you add them to a knowledge base."
        size="medium"
      >
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
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

          <FileVisibilitySelector
            visibility={visibility}
            onVisibilityChange={setVisibility}
            teamIds={teamIds}
            onTeamIdsChange={setTeamIds}
          />

          {failures.length > 0 && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <p className="font-medium text-destructive text-sm">
                Could not read {failures.length}{" "}
                {failures.length === 1 ? "document" : "documents"}
              </p>
              <p className="mt-1 text-muted-foreground text-xs">
                {failures.join(", ")}. A scanned PDF with no text layer has
                nothing to index — run OCR over it first.
              </p>
            </div>
          )}
        </div>

        <DialogStickyFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            <span>Cancel</span>
          </Button>
          <Button disabled={!canSubmit} onClick={() => void handleUpload()}>
            <Upload className="mr-1 h-4 w-4" />
            <span>
              {progress
                ? `Uploading ${progress.done}/${progress.total}…`
                : files.length > 1
                  ? `Upload ${files.length} documents`
                  : "Upload"}
            </span>
          </Button>
        </DialogStickyFooter>
      </FormDialog>
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
