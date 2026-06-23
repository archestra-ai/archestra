"use client";

import {
  Download,
  FileArchive,
  FileAudio,
  FileCode,
  File as FileIcon,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** One row of a file list: a previewable item with a byte endpoint. */
export type FileListItem = {
  id: string;
  name: string;
  mimeType: string;
  /** Byte endpoint; empty for in-memory items (no download link rendered). */
  contentUrl: string;
  source?: string;
};

/**
 * The chat Files panel's list section, shared so every files surface (chat
 * sidebar, project pages) renders identically: icon per file type, row click
 * selects/previews, trailing download link. The title header is shown only when
 * a `title` is given — callers omit it when the panel holds a single group, so
 * a lone set of files needs no header to tell it apart.
 */
export function FileSection({
  title,
  items,
  selectedId,
  onSelect,
  renderActions,
}: {
  title?: string;
  items: FileListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /**
   * Custom trailing actions per row; return null/undefined to keep the
   * default download link for that row.
   */
  renderActions?: (item: FileListItem) => ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-4">
      {title && (
        <p className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </p>
      )}
      <div className="overflow-hidden rounded-md border">
        {items.map((item, i) => {
          const customActions = renderActions?.(item) ?? null;
          const isSelected = item.id === selectedId;
          return (
            <div
              key={item.id}
              className={cn(
                "flex items-center text-sm",
                i > 0 && "border-t",
                isSelected
                  ? "bg-accent font-medium text-accent-foreground"
                  : "hover:bg-muted/50",
              )}
            >
              {/* Clicking the row body opens the preview; the trailing actions
                  are siblings, so we never nest interactive elements. */}
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
              >
                <FileRowIcon name={item.name} mimeType={item.mimeType} />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
              </button>
              {customActions ??
                (item.contentUrl && (
                  <a
                    href={item.contentUrl}
                    download={item.name}
                    title={`Download ${item.name}`}
                    className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Download className="h-4 w-4" />
                    <span className="sr-only">Download {item.name}</span>
                  </a>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// === internal ===

/** Maps a file extension to a lucide category icon. */
const EXTENSION_ICONS: Record<string, LucideIcon> = {
  // images
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  svg: FileImage,
  bmp: FileImage,
  ico: FileImage,
  tiff: FileImage,
  heic: FileImage,
  avif: FileImage,
  // video
  mp4: FileVideo,
  mov: FileVideo,
  webm: FileVideo,
  avi: FileVideo,
  mkv: FileVideo,
  m4v: FileVideo,
  // audio
  mp3: FileAudio,
  wav: FileAudio,
  flac: FileAudio,
  ogg: FileAudio,
  m4a: FileAudio,
  aac: FileAudio,
  // archives
  zip: FileArchive,
  tar: FileArchive,
  gz: FileArchive,
  tgz: FileArchive,
  rar: FileArchive,
  "7z": FileArchive,
  bz2: FileArchive,
  // spreadsheets / tabular
  csv: FileSpreadsheet,
  tsv: FileSpreadsheet,
  xls: FileSpreadsheet,
  xlsx: FileSpreadsheet,
  // json
  json: FileJson,
  // code
  js: FileCode,
  jsx: FileCode,
  ts: FileCode,
  tsx: FileCode,
  py: FileCode,
  rb: FileCode,
  go: FileCode,
  rs: FileCode,
  java: FileCode,
  c: FileCode,
  h: FileCode,
  cpp: FileCode,
  cc: FileCode,
  cs: FileCode,
  php: FileCode,
  sh: FileCode,
  bash: FileCode,
  html: FileCode,
  css: FileCode,
  scss: FileCode,
  sql: FileCode,
  xml: FileCode,
  yml: FileCode,
  yaml: FileCode,
  toml: FileCode,
  // documents
  md: FileText,
  markdown: FileText,
  txt: FileText,
  rtf: FileText,
  pdf: FileText,
  doc: FileText,
  docx: FileText,
};

/** Pick a lucide icon for a file, by extension first then mime category. */
function getFileIcon(name: string, mimeType: string): LucideIcon {
  const ext = name.includes(".")
    ? (name.split(".").pop() ?? "").toLowerCase()
    : "";
  const byExt = EXTENSION_ICONS[ext];
  if (byExt) return byExt;

  const mime = mimeType.toLowerCase();
  if (mime.startsWith("image/")) return FileImage;
  if (mime.startsWith("video/")) return FileVideo;
  if (mime.startsWith("audio/")) return FileAudio;
  if (mime === "application/json") return FileJson;
  if (mime === "text/csv") return FileSpreadsheet;
  if (mime === "application/zip" || mime.includes("tar")) return FileArchive;
  if (mime.startsWith("text/")) return FileText;
  return FileIcon;
}

function FileRowIcon({ name, mimeType }: { name: string; mimeType: string }) {
  const Icon = getFileIcon(name, mimeType);
  return (
    <Icon className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
  );
}
