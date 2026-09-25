"use client";

import { FileText, FolderUp, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils/tailwind";

/**
 * The bordered file picker plus its hidden input. The entire surface opens the
 * picker; document uploads also accept drops.
 *
 * Selection state lives in the caller; this only reports files. Pair with
 * `StagedFileList` to show what has been picked.
 */
export function FileDropInput({
  accept,
  typesLabel,
  onFiles,
  directory = false,
  inputId,
  inputLabel,
}: {
  /** The input's `accept` attribute, e.g. ".pdf,.docx,.txt". */
  accept?: string;
  /** Supporting text shown under the picker prompt. */
  typesLabel: string;
  onFiles: (files: File[]) => void;
  directory?: boolean;
  inputId?: string;
  inputLabel?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    if (directory) inputRef.current?.setAttribute("webkitdirectory", "");
    else inputRef.current?.removeAttribute("webkitdirectory");
  }, [directory]);

  const handleDrag = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.type === "dragenter" || event.type === "dragover") {
      setDragActive(true);
    } else if (event.type === "dragleave") {
      setDragActive(false);
    }
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setDragActive(false);
      if (directory) return;
      const files = event.dataTransfer?.files;
      if (files?.length) onFiles([...files]);
    },
    [directory, onFiles],
  );

  return (
    <>
      <button
        type="button"
        aria-label={directory ? "Choose folder" : undefined}
        className={cn(
          "flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          directory
            ? "border-border bg-muted/30 hover:border-primary/50 hover:bg-muted/50"
            : dragActive
              ? "border-primary bg-primary/5"
              : "border-muted-foreground/25 hover:border-muted-foreground/50",
        )}
        onClick={() => inputRef.current?.click()}
        onDragEnter={directory ? undefined : handleDrag}
        onDragLeave={directory ? undefined : handleDrag}
        onDragOver={directory ? undefined : handleDrag}
        onDrop={directory ? undefined : handleDrop}
      >
        {directory ? (
          <>
            <FolderUp className="size-8 text-muted-foreground" />
            <span className="text-sm font-medium">Choose folder</span>
          </>
        ) : (
          <>
            <Upload className="size-8 text-muted-foreground/50" />
            <span className="text-sm text-muted-foreground">
              Drag documents here, or{" "}
              <span className="font-medium text-primary">browse</span>
            </span>
          </>
        )}
        <span className="text-xs text-muted-foreground/70">{typesLabel}</span>
      </button>
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        multiple
        accept={accept}
        className="hidden"
        aria-label={inputLabel ?? "Choose documents to upload"}
        onChange={(event) => {
          if (event.target.files?.length) onFiles([...event.target.files]);
          // Clearing lets the same file be re-picked after removing it.
          event.target.value = "";
        }}
      />
    </>
  );
}

/** The staged-selection list under a `FileDropInput`: name, size, remove. */
export function StagedFileList({
  files,
  onRemove,
}: {
  files: File[];
  onRemove: (file: File) => void;
}) {
  if (files.length === 0) return null;
  return (
    <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
      {files.map((file) => (
        <li
          key={`${file.name}:${file.size}`}
          className="flex items-center gap-2 rounded px-1 py-1 text-sm"
        >
          <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{file.name}</span>
          <span className="shrink-0 text-muted-foreground text-xs">
            {formatFileSize(file.size)}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            aria-label={`Remove ${file.name}`}
            onClick={() => onRemove(file)}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** Strips the `data:<mime>;base64,` prefix the FileReader adds. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
