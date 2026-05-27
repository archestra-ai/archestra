"use client";

import type { ResourceVisibilityScope } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import {
  FileText,
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
import { useCallback, useRef, useState, useTransition } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { KnowledgePageLayout } from "@/app/knowledge/_parts/knowledge-page-layout";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { useProfiles } from "@/lib/agent.query";
import {
  formatFileSize,
  type KnowledgeFile,
  useDeleteKnowledgeFile,
  useKnowledgeFilesPaginated,
  useKnowledgeFileUploadConfig,
  useUpdateKnowledgeFile,
  useUploadKnowledgeFiles,
} from "@/lib/knowledge/knowledge-files.query";
import { useTeams } from "@/lib/teams/team.query";
import { formatDate } from "@/lib/utils";

const ACCEPTED_EXTENSIONS = ".txt,.md,.csv,.json,.xml,.pdf";

const VISIBILITY_OPTIONS: Record<
  ResourceVisibilityScope,
  VisibilityOption<ResourceVisibilityScope>
> = {
  personal: {
    value: "personal",
    label: "Owner",
    description: "Only you can view and query this file",
    icon: User,
  },
  team: {
    value: "team",
    label: "Teams",
    description: "Share this file with selected teams",
    icon: Users,
  },
  org: {
    value: "org",
    label: "Organization",
    description: "Anyone in your org can view and query this file",
    icon: Globe,
  },
};

export default function KnowledgeFilesPage() {
  return (
    <ErrorBoundary>
      <KnowledgeFilesList />
    </ErrorBoundary>
  );
}

function KnowledgeFilesList() {
  const [isUploadOpen, setIsUploadOpen] = useState(false);
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
        <div className="flex min-w-0 items-center gap-2">
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">
            {row.original.originalName}
          </span>
        </div>
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
      id: "size",
      header: "Size",
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {formatFileSize(row.original.fileSize)}
        </span>
      ),
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
      header: "",
      size: 64,
      cell: ({ row }) => (
        <TooltipProvider>
          <div className="flex items-center justify-end gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <PermissionButton
                  permissions={{ knowledgeFile: ["update"] }}
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  onClick={(event) => {
                    event.stopPropagation();
                    setEditingFile(row.original);
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </PermissionButton>
              </TooltipTrigger>
              <TooltipContent>Edit file access</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <PermissionButton
                  permissions={{ knowledgeFile: ["delete"] }}
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  onClick={(event) => {
                    event.stopPropagation();
                    setDeletingFileId(row.original.id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </PermissionButton>
              </TooltipTrigger>
              <TooltipContent>Delete file</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      ),
    },
  ];

  const clearFilters = useCallback(() => setSearchInput(""), []);

  return (
    <KnowledgePageLayout
      title="Files"
      description="Upload files into knowledge retrieval and choose which agents can query them."
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
  const [visibility, setVisibility] =
    useState<ResourceVisibilityScope>("personal");
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [isPendingUpload, startUploadTransition] = useTransition();
  const uploadFiles = useUploadKnowledgeFiles();
  const { data: config } = useKnowledgeFileUploadConfig();

  const handleSubmit = () => {
    startUploadTransition(async () => {
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
    });
  };

  const isUploading = isPendingUpload || uploadFiles.isPending;
  const teamSelectionInvalid = visibility === "team" && teamIds.length === 0;
  const uploadDisabled =
    files.length === 0 || teamSelectionInvalid || isUploading;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Upload Files</DialogTitle>
          <DialogDescription>
            Uploaded files are indexed for retrieval by the selected agents.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label>Files</Label>
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_EXTENSIONS}
              multiple
              className="hidden"
              onChange={(event) =>
                setFiles(Array.from(event.target.files ?? []))
              }
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-4 w-4" />
              Select Files
            </Button>
            <p className="text-xs text-muted-foreground">
              TXT, Markdown, CSV, JSON, XML, and PDF files up to{" "}
              {formatFileSize(config?.maxFileSizeBytes ?? 10 * 1024 * 1024)}
            </p>
            {files.length > 0 && (
              <div className="rounded-md border">
                {files.map((file) => (
                  <div
                    key={`${file.name}-${file.size}-${file.lastModified}`}
                    className="flex items-center justify-between border-b px-3 py-2 last:border-b-0"
                  >
                    <span className="min-w-0 truncate text-sm">
                      {file.name}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatFileSize(file.size)}
                    </span>
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
          />
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={uploadDisabled}
            onClick={handleSubmit}
          >
            {isUploading && <Loader2 className="h-4 w-4 animate-spin" />}
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit File Access</DialogTitle>
          <DialogDescription>{file.originalName}</DialogDescription>
        </DialogHeader>
        <KnowledgeFileAccessFields
          visibility={visibility}
          onVisibilityChange={setVisibility}
          teamIds={teamIds}
          onTeamIdsChange={setTeamIds}
          agentIds={agentIds}
          onAgentIdsChange={setAgentIds}
        />
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={
              updateFile.isPending ||
              (visibility === "team" && teamIds.length === 0)
            }
            onClick={handleSave}
          >
            {updateFile.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function KnowledgeFileAccessFields({
  visibility,
  onVisibilityChange,
  teamIds,
  onTeamIdsChange,
  agentIds,
  onAgentIdsChange,
}: {
  visibility: ResourceVisibilityScope;
  onVisibilityChange: (visibility: ResourceVisibilityScope) => void;
  teamIds: string[];
  onTeamIdsChange: (teamIds: string[]) => void;
  agentIds: string[];
  onAgentIdsChange: (agentIds: string[]) => void;
}) {
  const { data: teams } = useTeams();
  const { data: agents } = useProfiles({
    filters: { agentTypes: ["agent", "mcp_gateway"] },
  });

  const options = Object.values(VISIBILITY_OPTIONS).map((option) => ({
    ...option,
    disabled: option.value === "team" && (teams ?? []).length === 0,
    disabledLabel:
      option.value === "team" && (teams ?? []).length === 0
        ? "No teams available"
        : undefined,
  }));

  return (
    <div className="space-y-5">
      <VisibilitySelector
        value={visibility}
        options={options}
        onValueChange={onVisibilityChange}
      >
        {visibility === "team" && (
          <div className="space-y-2">
            <Label>Teams</Label>
            <MultiSelectCombobox
              options={(teams ?? []).map((team) => ({
                value: team.id,
                label: team.name,
              }))}
              value={teamIds}
              onChange={onTeamIdsChange}
              placeholder="Search teams..."
              emptyMessage="No teams found."
            />
          </div>
        )}
      </VisibilitySelector>

      <div className="space-y-2">
        <Label>Agents</Label>
        <MultiSelectCombobox
          options={(agents ?? []).map((agent) => ({
            value: agent.id,
            label: agent.name,
          }))}
          value={agentIds}
          onChange={onAgentIdsChange}
          placeholder="Search agents..."
          emptyMessage="No agents found."
        />
      </div>
    </div>
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
    <TooltipProvider>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {visibleAgents.map((agent) => (
          <Badge key={agent.id} variant="outline" className="max-w-[140px]">
            <span className="truncate">{agent.name}</span>
          </Badge>
        ))}
        {hiddenAgents.length > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline">+{hiddenAgents.length}</Badge>
            </TooltipTrigger>
            <TooltipContent>
              <div className="space-y-1">
                {hiddenAgents.map((agent) => (
                  <div key={agent.id}>{agent.name}</div>
                ))}
              </div>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
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
