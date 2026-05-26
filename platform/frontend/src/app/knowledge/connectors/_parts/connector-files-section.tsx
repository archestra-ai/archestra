"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { AlertCircle, Loader2, Search, Trash2, Upload, X } from "lucide-react";
import type { ReactNode } from "react";
import {
  useActionState,
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import {
  formatFileSize,
  type UploadedFile,
  useConnectorFile,
  useConnectorFilesPaginated,
  useDeleteConnectorFile,
  useUploadConnectorFiles,
} from "@/lib/knowledge/connector-files.query";
import { cn } from "@/lib/utils";

const ACCEPTED_EXTENSIONS =
  ".txt,.md,.csv,.json,.xml,.html,.htm,.pdf,.doc,.docx,.zip";
const MAX_FILE_SIZE_MB = 10;

const EMBEDDING_ERROR_MESSAGES = {
  rate_limited:
    "The embedding provider rate limit was reached. Try again later or adjust the provider limits.",
  auth_error:
    "The embedding provider rejected the configured API key or credentials.",
  model_not_found:
    "The configured embedding model was not found. Check the selected embedding model.",
  server_error:
    "The embedding provider returned a server error. Try again later.",
  dimensions_mismatch:
    "The embedding model returned vectors with dimensions that do not match the configured database column.",
  unknown:
    "Embedding failed for an unknown reason. Check the embedding provider configuration and logs.",
} as const;

function getEmbeddingErrorMessage(error?: string | null) {
  if (!error) return EMBEDDING_ERROR_MESSAGES.unknown;
  return (
    EMBEDDING_ERROR_MESSAGES[error as keyof typeof EMBEDDING_ERROR_MESSAGES] ??
    EMBEDDING_ERROR_MESSAGES.unknown
  );
}

function StatusTooltipBadge({
  variant,
  label,
  tooltip,
  children,
}: {
  variant: "default" | "secondary" | "destructive" | "outline";
  label: string;
  tooltip: string;
  children?: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            badgeVariants({ variant }),
            "capitalize text-xs cursor-help appearance-none",
          )}
          aria-label={`${label}: ${tooltip}`}
        >
          {children}
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-80 break-words">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

function FileStatusBadge({
  processingStatus,
  embeddingStatus,
  processingError,
  embeddingError,
}: {
  processingStatus?: string;
  embeddingStatus: string;
  processingError?: string | null;
  embeddingError?: string | null;
}) {
  if (processingStatus && processingStatus !== "completed") {
    const variants = {
      pending: "secondary",
      processing: "secondary",
      failed: "destructive",
    } as const;

    const labels = {
      pending: "Queued",
      processing: "Extracting…",
      failed: "Processing Failed",
    };

    const variant =
      variants[processingStatus as keyof typeof variants] ?? "secondary";
    const label =
      labels[processingStatus as keyof typeof labels] ?? processingStatus;
    const tooltip =
      processingStatus === "failed" && processingError
        ? processingError
        : processingStatus === "pending"
          ? "File is queued for text extraction"
          : "Extracting text from file…";

    return (
      <StatusTooltipBadge variant={variant} label={label} tooltip={tooltip}>
        {processingStatus === "processing" && (
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
        )}
      </StatusTooltipBadge>
    );
  }

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
  const variant =
    variants[embeddingStatus as keyof typeof variants] ?? "secondary";
  const label =
    labels[embeddingStatus as keyof typeof labels] ?? embeddingStatus;

  if (embeddingStatus === "failed") {
    const tooltip = getEmbeddingErrorMessage(embeddingError);
    return (
      <StatusTooltipBadge variant={variant} label={label} tooltip={tooltip}>
        <AlertCircle className="h-3 w-3 mr-1" />
      </StatusTooltipBadge>
    );
  }

  return (
    <Badge variant={variant} className="capitalize text-xs">
      {embeddingStatus === "processing" && (
        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
      )}
      {label}
    </Badge>
  );
}

function FileStatusCell({
  file,
  connectorId,
}: {
  file: UploadedFile;
  connectorId: string;
}) {
  const { data: freshFile } = useConnectorFile(connectorId, file.id);
  const current = freshFile ?? file;

  return (
    <FileStatusBadge
      processingStatus={current.processingStatus}
      embeddingStatus={current.embeddingStatus}
      processingError={current.processingError}
      embeddingError={current.embeddingError}
    />
  );
}

function DeleteFileButton({
  fileId,
  connectorId,
}: {
  fileId: string;
  connectorId: string;
}) {
  const deleteFile = useDeleteConnectorFile(connectorId);

  const [, deleteAction, isDeleting] = useActionState(
    async (_: null, _formData: FormData) => {
      await deleteFile.mutateAsync(fileId);
      return null;
    },
    null,
  );

  return (
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
  );
}

function useDebounce<T>(
  value: T,
  delayMs: number,
  onValueChange?: () => void,
): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
      onValueChange?.();
    }, delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs, onValueChange]);
  return debouncedValue;
}

export function ConnectorFilesSection({
  connectorId,
}: {
  connectorId: string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [searchInput, setSearchInput] = useState("");

  const [pageIndex, setPageIndex] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_TABLE_LIMIT);
  const offset = pageIndex * pageSize;

  const debouncedSearch = useDebounce(searchInput, 300);

  const {
    data: filesResponse,
    isPending,
    isFetching,
  } = useConnectorFilesPaginated({
    connectorId,
    limit: pageSize,
    offset,
    search: debouncedSearch || undefined,
  });

  const items = filesResponse?.data ?? [];
  const pagination = filesResponse?.pagination;

  const uploadFiles = useUploadConnectorFiles(connectorId);

  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      setPageIndex(newPagination.pageIndex);
      setPageSize(newPagination.pageSize);
    },
    [],
  );

  const columns: ColumnDef<UploadedFile>[] = [
    {
      id: "originalName",
      accessorKey: "originalName",
      header: "Name",
      cell: ({ row }) => (
        <span className="text-sm truncate block max-w-[280px]">
          {row.original.originalName}
        </span>
      ),
    },
    {
      id: "fileSize",
      accessorKey: "fileSize",
      header: "Size",
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {formatFileSize(row.original.fileSize)}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => (
        <FileStatusCell file={row.original} connectorId={connectorId} />
      ),
    },
    {
      id: "actions",
      header: "",
      size: 40,
      cell: ({ row }) => (
        <DeleteFileButton fileId={row.original.id} connectorId={connectorId} />
      ),
    },
  ];

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
      if (selectedFiles.length > 0) handleDrop(selectedFiles);
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
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search files by name…"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="pl-9 h-9"
        />
        {searchInput && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
            onClick={() => setSearchInput("")}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      <DataTable
        columns={columns}
        data={items}
        getRowId={(row) => row.id}
        emptyMessage="No files uploaded"
        hasActiveFilters={!!debouncedSearch}
        onClearFilters={() => setSearchInput("")}
        filteredEmptyMessage="No files match your search"
        hideSelectedCount
        manualPagination
        pagination={{
          pageIndex,
          pageSize,
          total: pagination?.total ?? 0,
        }}
        onPaginationChange={handlePaginationChange}
        isLoading={isFetching || isPending}
      />

      <button
        type="button"
        className="w-full border border-dashed rounded-lg p-10 text-center cursor-pointer hover:bg-muted/30 transition-colors"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const droppedFiles = Array.from(e.dataTransfer.files);
          handleDrop(droppedFiles);
        }}
        onClick={() => fileInputRef.current?.click()}
        disabled={isActuallyUploading}
      >
        <Upload className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
        <p className="text-sm font-medium">
          Drop files here or click to upload
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          Supports .txt, .md, .csv, .json, .xml, .html, .pdf, .doc, .docx, .zip
          — max {MAX_FILE_SIZE_MB} MB each
        </p>
      </button>
    </div>
  );
}
