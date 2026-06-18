"use client";

import {
  KNOWLEDGE_FILE_ACCEPT_ATTRIBUTE,
  KNOWLEDGE_FILE_SUPPORTED_FORMATS_LABEL,
  MAX_KNOWLEDGE_FILES_PER_UPLOAD,
  type ResourceVisibilityScope,
} from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import {
  Download,
  Eye,
  Globe,
  Loader2,
  Pencil,
  Search,
  Trash2,
  Upload,
  User,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { KnowledgePageLayout } from "@/app/knowledge/_parts/knowledge-page-layout";
import {
  downloadKnowledgeFile,
  KnowledgeFileViewerDialog,
} from "@/app/knowledge/files/_parts/knowledge-file-viewer-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { StandardFormDialog } from "@/components/standard-dialog";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TruncatedTooltip } from "@/components/ui/truncated-tooltip";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import {
  formatFileSize,
  type KnowledgeFile,
  useDeleteKnowledgeFile,
  useKnowledgeFilesPaginated,
  useKnowledgeFileUploadConfig,
  useUpdateKnowledgeFile,
  useUploadKnowledgeFiles,
} from "@/lib/knowledge/knowledge-files.query";
import { cn, formatDate } from "@/lib/utils";
import { KnowledgeFileAccessFields } from "./_parts/knowledge-file-access-fields";

export default function KnowledgeFilesPage() {
  return (
    <ErrorBoundary>
      <KnowledgeFilesList />
    </ErrorBoundary>
  );
}

function KnowledgeFilesList() {
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [viewingFile, setViewingFile] = useState<KnowledgeFile | null>(null);
  const [editingFile, setEditingFile] = useState<KnowledgeFile | null>(null);
  const [deletingFileId, setDeletingFileId] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_TABLE_LIMIT);
  const [searchInput, setSearchInput] = useState("");
  const offset = pageIndex * pageSize;

  const {
    data: filesResponse,
    isPending,
    isFetching,
  } = useKnowledgeFilesPaginated({
    limit: pageSize,
    offset,
    search: searchInput || undefined,
  });

  const columns: ColumnDef<KnowledgeFile>[] = [
    {
      id: "name",
      accessorKey: "originalName",
      header: "File",
      cell: ({ row }) => (
        <TruncatedTooltip content={row.original.originalName}>
          <Button
            type="button"
            variant="ghost"
            className="h-auto min-w-0 max-w-full justify-start bg-transparent p-0 text-left hover:bg-transparent"
          >
            <span className="truncate text-sm font-medium">
              {row.original.originalName}
            </span>
          </Button>
        </TruncatedTooltip>
      ),
    },
    {
      id: "visibility",
      header: "Visibility",
      cell: ({ row }) => <VisibilityBadge file={row.original} />,
    },
    {
      id: "agents",
      header: "Agents",
      cell: ({ row }) => <AssignedAgentsBadge file={row.original} />,
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => <FileStatusBadge file={row.original} />,
    },
    {
      id: "createdAt",
      header: "Uploaded",
      cell: ({ row }) => (
        <span
          className="text-sm text-muted-foreground"
          title={formatDate({ date: row.original.createdAt })}
        >
          {formatDistanceToNow(new Date(row.original.createdAt), {
            addSuffix: true,
          })}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      size: 144,
      cell: ({ row }) => {
        const file = row.original;
        const actions: TableRowAction[] = [
          {
            icon: <Eye className="h-4 w-4" />,
            label: "View",
            permissions: { knowledgeFile: ["read"] },
            onClick: () => setViewingFile(file),
          },
          {
            icon: <Pencil className="h-4 w-4" />,
            label: "Edit",
            permissions: { knowledgeFile: ["update"] },
            onClick: () => setEditingFile(file),
          },
          {
            icon: <Download className="h-4 w-4" />,
            label: "Download",
            permissions: { knowledgeFile: ["read"] },
            onClick: () => downloadKnowledgeFile(file),
          },
          {
            icon: <Trash2 className="h-4 w-4" />,
            label: "Delete",
            permissions: { knowledgeFile: ["delete"] },
            variant: "destructive",
            onClick: () => setDeletingFileId(file.id),
          },
        ];

        return <TableRowActions actions={actions} />;
      },
    },
  ];

  const clearFilters = useCallback(() => setSearchInput(""), []);

  return (
    <KnowledgePageLayout
      title="Files"
      description="Upload retrieval files, control who can access them, and choose which agents or MCP gateways can query them."
      createLabel="Upload Files"
      onCreateClick={() => setIsUploadOpen(true)}
      createPermissions={{ knowledgeFile: ["create"] }}
      isPending={isPending && !filesResponse}
    >
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="relative w-[330px]">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(event) => {
                setSearchInput(event.target.value);
                setPageIndex(0);
              }}
              placeholder="Search files by name..."
              className="h-9 pl-9"
            />
            {searchInput && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2"
                onClick={() => setSearchInput("")}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        <DataTable
          columns={columns}
          data={filesResponse?.data ?? []}
          getRowId={(row) => row.id}
          emptyMessage="No files uploaded"
          hasActiveFilters={!!searchInput}
          onClearFilters={clearFilters}
          filteredEmptyMessage="No files match your search"
          hideSelectedCount
          manualPagination
          pagination={{
            pageIndex,
            pageSize,
            total: filesResponse?.pagination.total ?? 0,
          }}
          onPaginationChange={({ pageIndex, pageSize }) => {
            setPageIndex(pageIndex);
            setPageSize(pageSize);
          }}
          isLoading={isFetching || isPending}
        />
      </div>

      <UploadKnowledgeFilesDialog
        open={isUploadOpen}
        onOpenChange={setIsUploadOpen}
      />
      {viewingFile && (
        <KnowledgeFileViewerDialog
          file={viewingFile}
          open={!!viewingFile}
          onOpenChange={(open) => !open && setViewingFile(null)}
        />
      )}
      {editingFile && (
        <EditKnowledgeFileDialog
          file={editingFile}
          open={!!editingFile}
          onOpenChange={(open) => !open && setEditingFile(null)}
        />
      )}
      {deletingFileId && (
        <DeleteKnowledgeFileDialog
          fileId={deletingFileId}
          open={!!deletingFileId}
          onOpenChange={(open) => !open && setDeletingFileId(null)}
        />
      )}
    </KnowledgePageLayout>
  );
}

function UploadKnowledgeFilesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [visibility, setVisibility] =
    useState<ResourceVisibilityScope>("personal");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const uploadFiles = useUploadKnowledgeFiles();
  const { data: config } = useKnowledgeFileUploadConfig();

  const handleSubmit = async () => {
    const result = await uploadFiles.mutateAsync({
      files,
      visibility,
      teamIds,
      agentIds,
    });
    if (result) {
      setFiles([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      setVisibility("personal");
      setTeamIds([]);
      setAgentIds([]);
      onOpenChange(false);
    }
  };

  const isUploading = uploadFiles.isPending;
  const teamSelectionInvalid = visibility === "team" && teamIds.length === 0;
  const uploadDisabled =
    files.length === 0 || teamSelectionInvalid || isUploading;

  const exceededLimitRef = useRef(false);

  const addFiles = (incoming: File[]) => {
    if (incoming.length === 0) return;
    const fileKey = (file: File) =>
      `${file.name}:${file.size}:${file.lastModified}`;
    setFiles((prev) => {
      const seen = new Set(prev.map(fileKey));
      const merged = [...prev];
      for (const file of incoming) {
        const key = fileKey(file);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(file);
      }
      if (merged.length > MAX_KNOWLEDGE_FILES_PER_UPLOAD) {
        exceededLimitRef.current = true;
        return merged.slice(0, MAX_KNOWLEDGE_FILES_PER_UPLOAD);
      }
      return merged;
    });
  };

  // Warn after commit rather than inside the updater so the toast fires once.
  useEffect(() => {
    if (!exceededLimitRef.current) return;
    exceededLimitRef.current = false;
    toast.warning(
      `Up to ${MAX_KNOWLEDGE_FILES_PER_UPLOAD} files can be uploaded at once. Only the first ${MAX_KNOWLEDGE_FILES_PER_UPLOAD} were kept.`,
    );
  });

  const removeFile = (target: File) => {
    setFiles((prev) => prev.filter((file) => file !== target));
  };

  const handleDrop = (event: React.DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setIsDraggingFiles(false);

    const items = Array.from(event.dataTransfer.items);
    if (items.length === 0) {
      addFiles(Array.from(event.dataTransfer.files));
      return;
    }

    const droppedFiles: File[] = [];
    let hadDirectory = false;
    for (const item of items) {
      if (item.kind !== "file") continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        hadDirectory = true;
        continue;
      }
      const file = item.getAsFile();
      if (file) droppedFiles.push(file);
    }
    if (hadDirectory) {
      toast.warning("Folders aren't supported — drop individual files.");
    }
    if (droppedFiles.length === 0 && !hadDirectory) {
      // Browser without the entry API: stage whatever it exposed directly.
      addFiles(Array.from(event.dataTransfer.files));
      return;
    }
    addFiles(droppedFiles);
  };

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Upload Files"
      description="Uploaded files are indexed for retrieval by the selected Agents / MCP Gateways."
      size="medium"
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
          <Button type="submit" disabled={uploadDisabled}>
            {isUploading && <Loader2 className="h-4 w-4 animate-spin" />}
            Upload
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <Label>Files</Label>
          <input
            ref={fileInputRef}
            type="file"
            accept={KNOWLEDGE_FILE_ACCEPT_ATTRIBUTE}
            multiple
            className="hidden"
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              // Reset so re-picking the same file fires onChange again.
              event.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="outline"
            className={cn(
              "flex h-auto min-h-24 w-full cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed bg-transparent p-6 text-center hover:bg-muted/30",
              isDraggingFiles
                ? "border-primary bg-primary/5"
                : "border-muted-foreground/25 hover:border-muted-foreground/50",
            )}
            onClick={() => fileInputRef.current?.click()}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDraggingFiles(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDraggingFiles(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              setIsDraggingFiles(false);
            }}
            onDrop={handleDrop}
          >
            <Upload className="mb-2 h-7 w-7 text-muted-foreground" />
            <p className="text-sm font-medium">
              Drop files here or click to browse
            </p>
          </Button>
          <p className="text-xs text-muted-foreground">
            {KNOWLEDGE_FILE_SUPPORTED_FORMATS_LABEL} files up to{" "}
            {formatFileSize(config?.maxFileSizeBytes ?? 10 * 1024 * 1024)}
          </p>
          {files.length > 0 && (
            <div className="rounded-md border">
              <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
                <span>Selected files</span>
                <span>
                  {files.length} / {MAX_KNOWLEDGE_FILES_PER_UPLOAD}
                </span>
              </div>
              {files.map((file) => (
                <div
                  key={`${file.name}-${file.size}-${file.lastModified}`}
                  className="flex items-center gap-2 border-b px-3 py-2 last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {file.name}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatFileSize(file.size)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => removeFile(file)}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <KnowledgeFileAccessFields
          visibility={visibility}
          onVisibilityChange={setVisibility}
          teamIds={teamIds}
          onTeamIdsChange={setTeamIds}
          agentIds={agentIds}
          onAgentIdsChange={setAgentIds}
          defaultToAllAgents
        />
      </div>
    </StandardFormDialog>
  );
}

function EditKnowledgeFileDialog({
  file,
  open,
  onOpenChange,
}: {
  file: KnowledgeFile;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [visibility, setVisibility] = useState<ResourceVisibilityScope>(
    file.visibility,
  );
  const [teamIds, setTeamIds] = useState<string[]>(file.teamIds);
  const [agentIds, setAgentIds] = useState<string[]>(
    file.assignedAgents.map((agent) => agent.id),
  );
  const updateFile = useUpdateKnowledgeFile();

  const handleSave = async () => {
    const result = await updateFile.mutateAsync({
      fileId: file.id,
      body: { visibility, teamIds, agentIds },
    });
    if (result) onOpenChange(false);
  };

  return (
    <StandardFormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Edit File Access"
      description={
        <div className="flex min-w-0 items-center gap-3">
          <div className="min-w-0 flex-1 truncate">{file.originalName}</div>
          <div className="text-xs text-muted-foreground">
            Size: {formatFileSize(file.fileSize)}
          </div>
        </div>
      }
      size="medium"
      onSubmit={handleSave}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={
              updateFile.isPending ||
              (visibility === "team" && teamIds.length === 0)
            }
          >
            {updateFile.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            Save
          </Button>
        </>
      }
    >
      <KnowledgeFileAccessFields
        visibility={visibility}
        onVisibilityChange={setVisibility}
        teamIds={teamIds}
        onTeamIdsChange={setTeamIds}
        agentIds={agentIds}
        onAgentIdsChange={setAgentIds}
      />
    </StandardFormDialog>
  );
}

function FileStatusBadge({ file }: { file: KnowledgeFile }) {
  if (file.processingStatus !== "completed") {
    const label =
      file.processingStatus === "processing"
        ? "Extracting"
        : file.processingStatus === "failed"
          ? "Failed"
          : "Queued";
    return (
      <Badge
        variant={
          file.processingStatus === "failed" ? "destructive" : "secondary"
        }
        className="text-xs"
      >
        {file.processingStatus === "processing" && (
          <Loader2 className="h-3 w-3 animate-spin" />
        )}
        {label}
      </Badge>
    );
  }

  return (
    <Badge
      variant={file.embeddingStatus === "failed" ? "destructive" : "secondary"}
      className="text-xs"
    >
      {file.embeddingStatus === "processing" && (
        <Loader2 className="h-3 w-3 animate-spin" />
      )}
      {file.embeddingStatus === "completed" ? "Indexed" : file.embeddingStatus}
    </Badge>
  );
}

function VisibilityBadge({ file }: { file: KnowledgeFile }) {
  const Icon =
    file.visibility === "personal"
      ? User
      : file.visibility === "team"
        ? Users
        : Globe;
  const label =
    file.visibility === "personal"
      ? "Owner"
      : file.visibility === "team"
        ? `${file.teamIds.length} team${file.teamIds.length === 1 ? "" : "s"}`
        : "Organization";

  return (
    <Badge variant="secondary" className="text-xs">
      <Icon className="h-3 w-3" />
      {label}
    </Badge>
  );
}

function AssignedAgentsBadge({ file }: { file: KnowledgeFile }) {
  if (file.assignedAgents.length === 0) {
    return <span className="text-xs text-muted-foreground">None</span>;
  }

  const visibleAgents = file.assignedAgents.slice(0, 2);
  const hiddenAgents = file.assignedAgents.slice(2);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {visibleAgents.map((agent) => (
        <Badge key={agent.id} variant="outline" className="max-w-[140px]">
          <span className="truncate">{agent.name}</span>
        </Badge>
      ))}
      {hiddenAgents.length > 0 && (
        <Badge variant="outline">+{hiddenAgents.length} more</Badge>
      )}
    </div>
  );
}

function DeleteKnowledgeFileDialog({
  fileId,
  open,
  onOpenChange,
}: {
  fileId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteFile = useDeleteKnowledgeFile();

  return (
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete File"
      description="This removes the uploaded file and its indexed content."
      confirmLabel="Delete File"
      isPending={deleteFile.isPending}
      onConfirm={async () => {
        const result = await deleteFile.mutateAsync(fileId);
        if (result) onOpenChange(false);
      }}
    />
  );
}
