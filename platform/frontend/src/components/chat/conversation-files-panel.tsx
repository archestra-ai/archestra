"use client";

import {
  Check,
  Copy,
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
import { useEffect, useRef, useState } from "react";
import { ConversationArtifactPanel } from "@/components/chat/conversation-artifact";
import { Button } from "@/components/ui/button";
import { useConversationFiles } from "@/lib/chat/chat.query";
import {
  assembleFileSections,
  type ConversationFileItem,
} from "@/lib/chat/conversation-files";
import { getFilePreviewKind } from "@/lib/chat/file-preview-kind";
import { printMarkdownElementAsPdf } from "@/lib/chat/print-markdown";
import { cn } from "@/lib/utils";

interface ConversationFilesPanelProps {
  conversationId: string | undefined;
  artifact: string | null | undefined;
  onClose: () => void;
}

export function ConversationFilesPanel({
  conversationId,
  artifact,
  onClose,
}: ConversationFilesPanelProps) {
  const { data: files } = useConversationFiles(conversationId);
  const { generated, attachments } = assembleFileSections({ files, artifact });
  const hasArtifact = !!artifact && artifact.trim().length > 0;
  // Default to previewing the artifact when one exists as the panel opens.
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    hasArtifact ? "artifact" : null,
  );

  const all = [...generated, ...attachments];
  const selected = all.find((f) => f.id === selectedId) ?? null;

  // download_file outputs only (the artifact has its own default handling).
  const generatedFileIds = generated
    .filter((f) => f.source === "generated")
    .map((f) => f.id);
  const newestGeneratedId = generatedFileIds.at(-1);
  const generatedKey = generatedFileIds.join("|");
  const filesLoaded = files !== undefined;

  // Clear the preview if the selected file disappears (e.g. artifact cleared).
  // Depend on a stable boolean, not the freshly-built `all` array each render.
  const selectedMissing = selectedId !== null && selected === null;
  useEffect(() => {
    if (selectedMissing) {
      setSelectedId(null);
    }
  }, [selectedMissing]);

  // Default the preview when nothing is selected: the artifact first, otherwise
  // the newest generated file. Covers panel open, files loading in, and a
  // cleared selection. A file the user actively picked keeps `selectedId`
  // non-null, so this never overrides it.
  useEffect(() => {
    if (selectedId !== null) return;
    if (hasArtifact) {
      setSelectedId("artifact");
    } else if (newestGeneratedId) {
      setSelectedId(newestGeneratedId);
    }
  }, [selectedId, hasArtifact, newestGeneratedId]);

  // Follow the latest produced output: when the artifact is (re)written switch
  // back to it, when a download_file output is created switch to that file — the
  // same "pop" the artifact does. The first loaded set is captured as a baseline
  // so existing files/artifact don't hijack the view when the panel opens.
  const prevArtifactRef = useRef<string | null | undefined>(undefined);
  const seenGeneratedRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!filesLoaded) return;
    const ids = generatedKey ? generatedKey.split("|") : [];
    const prevGenerated = seenGeneratedRef.current;
    const prevArtifact = prevArtifactRef.current;
    seenGeneratedRef.current = new Set(ids);
    prevArtifactRef.current = artifact;
    if (prevGenerated === null) return; // baseline only — default handles open

    if (hasArtifact && artifact !== prevArtifact) {
      setSelectedId("artifact");
      return;
    }
    const fresh = ids.filter((id) => !prevGenerated.has(id));
    if (fresh.length > 0) {
      setSelectedId(fresh[fresh.length - 1]);
    }
  }, [filesLoaded, generatedKey, artifact, hasArtifact]);

  // The artifact is rendered once and kept mounted whenever it exists, so its
  // row's "Download as PDF" button has rendered content to print even when the
  // artifact isn't the open file. It's shown in the preview slot when selected,
  // hidden otherwise.
  const artifactRef = useRef<HTMLDivElement>(null);
  const handleDownloadArtifactPdf = () =>
    printMarkdownElementAsPdf(artifactRef.current, "Artifact");
  const artifactSelected = selected?.source === "artifact";

  if (generated.length === 0 && attachments.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center text-xs text-muted-foreground">
        <FileIcon className="mb-2 h-6 w-6 opacity-50" />
        <p className="font-medium">No files yet</p>
        <p className="mt-1">
          Artifacts, generated files, and attachments for this conversation will
          appear here.
        </p>
      </div>
    );
  }

  // List always stays visible; the selected file previews below it in the same
  // sidebar (stacked master-detail). When nothing is selected the list fills the
  // panel; once a file is open the list is capped and the preview takes the rest.
  return (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          "overflow-y-auto px-3 py-3",
          selected ? "max-h-[45%] shrink-0 border-b" : "flex-1",
        )}
      >
        <FileSection
          title="Results"
          items={generated}
          selectedId={selectedId}
          artifact={artifact}
          onSelect={setSelectedId}
          onDownloadArtifactPdf={handleDownloadArtifactPdf}
        />
        <FileSection
          title="Attachments"
          items={attachments}
          selectedId={selectedId}
          artifact={artifact}
          onSelect={setSelectedId}
          onDownloadArtifactPdf={handleDownloadArtifactPdf}
        />
      </div>

      {hasArtifact && (
        <div
          ref={artifactRef}
          className={cn(
            artifactSelected ? "min-h-0 flex-1 overflow-auto" : "hidden",
          )}
        >
          <ConversationArtifactPanel
            artifact={artifact}
            isOpen
            onToggle={onClose}
            embedded
            hideHeader
          />
        </div>
      )}

      {selected && !artifactSelected && (
        <FilePreview file={selected} onClose={onClose} />
      )}
    </div>
  );
}

// === internal components ===

function FileSection({
  title,
  items,
  selectedId,
  artifact,
  onSelect,
  onDownloadArtifactPdf,
}: {
  title: string;
  items: ConversationFileItem[];
  selectedId: string | null;
  artifact: string | null | undefined;
  onSelect: (id: string) => void;
  onDownloadArtifactPdf: () => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="mb-4">
      <p className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <div className="overflow-hidden rounded-md border">
        {items.map((item, i) => (
          <div
            key={item.id}
            className={cn(
              "flex items-center text-sm hover:bg-muted/50",
              i > 0 && "border-t",
              item.id === selectedId && "bg-muted",
            )}
          >
            {/* Clicking the row body opens the preview; the trailing actions are
                siblings, so we never nest interactive elements. */}
            <button
              type="button"
              onClick={() => onSelect(item.id)}
              className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left"
            >
              <FileRowIcon name={item.name} mimeType={item.mimeType} />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
            </button>
            {item.source === "artifact" ? (
              <ArtifactRowActions
                content={artifact ?? ""}
                onDownloadPdf={onDownloadArtifactPdf}
              />
            ) : (
              item.contentUrl && (
                <a
                  href={item.contentUrl}
                  download={item.name}
                  title={`Download ${item.name}`}
                  className="mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Download className="h-4 w-4" />
                  <span className="sr-only">Download {item.name}</span>
                </a>
              )
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Row actions for the artifact: copy the in-memory markdown and download it as a
 * PDF. The artifact has no byte endpoint, so it doesn't get the plain download
 * link the other rows use.
 */
function ArtifactRowActions({
  content,
  onDownloadPdf,
}: {
  content: string;
  onDownloadPdf: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — nothing to do.
    }
  };

  return (
    <div className="flex shrink-0 items-center pr-1">
      <button
        type="button"
        onClick={handleCopy}
        title="Copy"
        className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        <span className="sr-only">Copy artifact</span>
      </button>
      <button
        type="button"
        onClick={onDownloadPdf}
        title="Download as PDF"
        className="flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Download className="h-4 w-4" />
        <span className="sr-only">Download artifact as PDF</span>
      </button>
    </div>
  );
}

/** Content-only preview for a non-artifact file (the open row stays highlighted). */
function FilePreview({
  file,
  onClose,
}: {
  file: ConversationFileItem;
  onClose: () => void;
}) {
  const kind = getFilePreviewKind(file.mimeType, file.name);

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {kind === "markdown" && (
        <RemoteMarkdownPreview contentUrl={file.contentUrl} onClose={onClose} />
      )}
      {kind === "image" && (
        <div className="flex h-full items-center justify-center p-4">
          <img
            src={file.contentUrl}
            alt={file.name}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      )}
      {(kind === "text" || kind === "csv") && (
        <FileTextPreview
          contentUrl={file.contentUrl}
          asTable={kind === "csv"}
        />
      )}
      {kind === "unsupported" && <UnsupportedPreview file={file} />}
    </div>
  );
}

/** Fetch a file's bytes as text from its content endpoint. */
function useFileText(contentUrl: string): {
  text: string | null;
  failed: boolean;
} {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setFailed(false);
    fetch(contentUrl)
      .then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.text();
      })
      .then((t) => {
        if (!cancelled) setText(t);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [contentUrl]);

  return { text, failed };
}

/** Markdown file served from a byte endpoint (an attachment or generated .md). */
function RemoteMarkdownPreview({
  contentUrl,
  onClose,
}: {
  contentUrl: string;
  onClose: () => void;
}) {
  const { text, failed } = useFileText(contentUrl);
  if (failed) {
    return (
      <p className="p-4 text-xs text-muted-foreground">
        Failed to load preview.
      </p>
    );
  }
  if (text === null) {
    return <p className="p-4 text-xs text-muted-foreground">Loading…</p>;
  }
  return (
    <ConversationArtifactPanel
      artifact={text}
      isOpen
      onToggle={onClose}
      embedded
      hideHeader
    />
  );
}

function FileTextPreview({
  contentUrl,
  asTable,
}: {
  contentUrl: string;
  asTable: boolean;
}) {
  const { text, failed } = useFileText(contentUrl);

  if (failed) {
    return (
      <p className="p-4 text-xs text-muted-foreground">
        Failed to load preview.
      </p>
    );
  }
  if (text === null) {
    return <p className="p-4 text-xs text-muted-foreground">Loading…</p>;
  }
  if (asTable) {
    // Naive CSV: split on newlines/commas. Good enough for a preview; does not
    // handle quoted commas or embedded newlines.
    const rows = text
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split(","));
    return (
      <div className="overflow-auto p-2">
        <table className="w-full border-collapse text-xs">
          <tbody>
            {rows.map((cells, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static CSV preview; rows never reorder
              <tr key={`row-${r}`} className="border-b">
                {cells.map((c, ci) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static CSV preview; cells never reorder
                  <td key={`cell-${r}-${ci}`} className="border-r px-2 py-1">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <pre className="whitespace-pre-wrap break-words p-4 text-xs">{text}</pre>
  );
}

function UnsupportedPreview({ file }: { file: ConversationFileItem }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="rounded-md border px-3 py-2 text-xs font-semibold uppercase text-muted-foreground">
        {fileTag(file.name)}
      </span>
      <p className="text-xs text-muted-foreground">
        Preview isn't available for this file type.
      </p>
      {file.contentUrl && (
        <Button asChild variant="secondary" size="sm" className="gap-1">
          <a href={file.contentUrl} download={file.name}>
            <Download className="h-4 w-4" />
            Download
          </a>
        </Button>
      )}
    </div>
  );
}

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

/** Short uppercase tag from a filename extension (e.g. "chart.png" → "PNG"). */
function fileTag(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "FILE";
  return name
    .slice(dot + 1)
    .toUpperCase()
    .slice(0, 4);
}
