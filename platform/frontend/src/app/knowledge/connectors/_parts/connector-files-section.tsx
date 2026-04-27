"use client";

import { Check, Loader2, Pencil, Trash2, Upload, X } from "lucide-react";
import { useActionState, useCallback, useRef, useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  formatFileSize,
  type UploadedFile,
  useConnectorFile,
  useConnectorFiles,
  useDeleteConnectorFile,
  useUpdateConnectorFileTitle,
  useUploadConnectorFiles,
} from "@/lib/knowledge/connector-files.query";

const ACCEPTED_EXTENSIONS = ".txt,.md,.csv,.json,.xml,.html,.htm,.pdf,.doc,.docx,.zip";
const MAX_FILE_SIZE_MB = 10;

function EmbeddingStatusBadge({ status }: { status: string }) {
  const variants = {
    completed: "default",
    pending: "secondary",
    processing: "secondary",
    failed: "destructive",
  } as const;

  const labels = {
    completed: "Indexed",
    pending: "Pending",
    processing: "Indexing…",
    failed: "Failed",
  };

  return (
    <Badge
      variant={variants[status as keyof typeof variants] ?? "secondary"}
      className="capitalize text-xs"
    >
      {status === "processing" && (
        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
      )}
      {labels[status as keyof typeof labels] ?? status}
    </Badge>
  );
}

function EditableTitleCell({
  file,
  connectorId,
}: {
  file: UploadedFile;
  connectorId: string;
}) {
  const [editing, setEditing] = useState(false);
  const updateTitle = useUpdateConnectorFileTitle(connectorId);

  const [, titleAction, isSaving] = useActionState(
    async (_: null, formData: FormData) => {
      const title = (formData.get("title") as string | null)?.trim() ?? "";
      if (title && title !== file.title) {
        await updateTitle.mutateAsync({ fileId: file.id, title });
      }
      setEditing(false);
      return null;
    },
    null,
  );

  if (editing) {
    return (
      <form action={titleAction} className="flex items-center gap-1">
        <Input
          name="title"
          defaultValue={file.title}
          className="h-7 text-sm"
          onKeyDown={(e) => {
            if (e.key === "Escape") setEditing(false);
          }}
          autoFocus
        />
        <Button
          type="submit"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          disabled={isSaving}
        >
          <Check className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => setEditing(false)}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </form>
    );
  }

  return (
    <div className="flex items-center gap-1.5 group min-w-0">
      <span className="text-sm truncate">{file.title}</span>
      <Button
        size="icon"
        variant="ghost"
        className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={() => setEditing(true)}
      >
        <Pencil className="h-3 w-3" />
      </Button>
    </div>
  );
}

function FileRow({
  fileId,
  connectorId,
}: {
  fileId: string;
  connectorId: string;
}) {
  const { data: file } = useConnectorFile(connectorId, fileId);
  const deleteFile = useDeleteConnectorFile(connectorId);

  const [, deleteAction, isDeleting] = useActionState(
    async (_: null, _formData: FormData) => {
      await deleteFile.mutateAsync(fileId);
      return null;
    },
    null,
  );

  if (!file) return null;

  return (
    <TableRow>
      <TableCell className="max-w-[180px]">
        <EditableTitleCell file={file} connectorId={connectorId} />
      </TableCell>
      <TableCell className="max-w-[180px] text-sm text-muted-foreground truncate">
        {file.originalName}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {formatFileSize(file.fileSize)}
      </TableCell>
      <TableCell>
        <EmbeddingStatusBadge status={file.embeddingStatus} />
      </TableCell>
      <TableCell className="flex justify-center">
        <form action={deleteAction}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="submit"
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-muted-foreground hover:text-destructive"
                disabled={isDeleting}
              >
                {isDeleting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Trash2 className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete file</TooltipContent>
          </Tooltip>
        </form>
      </TableCell>
    </TableRow>
  );
}

export function ConnectorFilesSection({
  connectorId,
}: {
  connectorId: string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: files = [], isPending } = useConnectorFiles(connectorId);
  const uploadFiles = useUploadConnectorFiles(connectorId);

  const [isPendingDrop, startDropTransition] = useTransition();
  const handleDrop = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      startDropTransition(async () => {
        await uploadFiles.mutateAsync(files);
      });
    },
    [uploadFiles],
  );

  const [, uploadAction, isUploading] = useActionState(
    async (_state: null, formData: FormData) => {
      const selectedFiles = formData.getAll("files") as File[];
      if (selectedFiles.length > 0) handleDrop(selectedFiles)
      return null;
    },
    null,
  );

  const isActuallyUploading = isUploading || isPendingDrop;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">Uploaded Files</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Text files and ZIP archives up to {MAX_FILE_SIZE_MB} MB each
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
          disabled={isActuallyUploading}
        >
          {isActuallyUploading ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : (
            <Upload className="h-4 w-4 mr-2" />
          )}
          {isActuallyUploading ? "Uploading..." : "Upload Files"}
        </Button>
      </div>

      <form action={uploadAction}>
        <input
          ref={fileInputRef}
          type="file"
          name="files"
          accept={ACCEPTED_EXTENSIONS}
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) {
              e.target.form?.requestSubmit();
              e.target.value = "";
            }
          }}
        />
      </form>
      {files.length ? (
        <div className="overflow-x-auto rounded-md border">
        <Table className="min-w-[540px]">
          <TableHeader>
            <TableRow>
              <TableHead className="whitespace-nowrap">Title</TableHead>
              <TableHead className="whitespace-nowrap">Original Name</TableHead>
              <TableHead className="whitespace-nowrap">Size</TableHead>
              <TableHead className="whitespace-nowrap">Status</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isPending ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center py-6">
                  <LoadingSpinner />
                </TableCell>
              </TableRow>
            ) : (
              files.map((file) => (
                <FileRow
                  key={file.id}
                  fileId={file.id}
                  connectorId={connectorId}
                />
              ))
            )}
          </TableBody>
        </Table>
        </div>
      ) : null}
      <button
        type="button"
        className="w-full border border-dashed rounded-lg p-10 text-center cursor-pointer hover:bg-muted/30 transition-colors"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const droppedFiles = Array.from(e.dataTransfer.files);
          handleDrop(droppedFiles)
        }}
        onClick={() => fileInputRef.current?.click()}
        disabled={isActuallyUploading}
      >
        <Upload className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
        <p className="text-sm font-medium">Drop files here or click to upload</p>
        <p className="text-xs text-muted-foreground mt-1">
          Supports .txt, .md, .csv, .json, .xml, .html, .pdf, .doc, .docx, .zip — max{" "}
          {MAX_FILE_SIZE_MB} MB each
        </p>
      </button>
    </div>
  );
}

function LoadingSpinner() {
  return <Loader2 className="h-5 w-5 animate-spin mx-auto text-muted-foreground" />;
}
