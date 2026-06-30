"use client";

import { EDITABLE_TEXT_FILE_MAX_BYTES } from "@archestra/shared";
import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { ConversationArtifactPanel } from "@/components/chat/conversation-artifact";
import { PlainTextEditor } from "@/components/chat/plain-text-editor";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { getFilePreviewKind } from "@/lib/chat/file-preview-kind";
import { useUpdateFileContent } from "@/lib/skills-sandbox/use-update-file-content";

/** Anything previewable: a display name, a MIME type, and a byte endpoint. */
export type PreviewableFile = {
  name: string;
  mimeType: string;
  contentUrl: string;
};

/**
 * Content-only preview for a file served from a byte endpoint: markdown
 * rendered, images inline, text/CSV as text/table, everything else a download
 * prompt. Extracted from the chat Files panel so the project pages preview
 * identically.
 *
 * Editing is controlled by the caller: when `editing` is true and a row-backed
 * `fileId` is given, the body swaps to an in-place text editor. The Edit toggle
 * itself lives in the caller's action row (next to Download/Delete); the caller
 * owns authorization and the `editing` flag, and `onExitEdit` fires when the
 * editor saves or cancels. An edit changes only the bytes — not the filename,
 * type, or list order — so the caller's file list needs no refresh.
 */
export function FilePreview({
  file,
  onClose,
  editing = false,
  fileId,
  onExitEdit,
}: {
  file: PreviewableFile;
  onClose?: () => void;
  /** Show the in-place editor instead of the preview (requires `fileId`). */
  editing?: boolean;
  /** The backing row id; required to edit (rowless objects aren't editable). */
  fileId?: string;
  /** Called when the editor saves or cancels, so the caller can clear `editing`. */
  onExitEdit?: () => void;
}) {
  const kind = getFilePreviewKind(file.mimeType, file.name);
  // After a save the bytes change but the URL doesn't, so a plain re-render would
  // show stale content (useFileText only refetches when the URL changes). Bump a
  // nonce into the URL to force the reload; the byte route is `no-cache`/ETag so
  // it revalidates against the new content.
  const [reloadNonce, setReloadNonce] = useState(0);
  const contentUrl = withReload(file.contentUrl, reloadNonce);

  if (editing && fileId) {
    return (
      <FileContentEditor
        key={contentUrl}
        fileId={fileId}
        contentUrl={contentUrl}
        onCancel={() => onExitEdit?.()}
        onSaved={() => {
          setReloadNonce((n) => n + 1);
          onExitEdit?.();
        }}
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {kind === "markdown" && (
        <RemoteMarkdownPreview
          contentUrl={contentUrl}
          onClose={onClose ?? (() => {})}
        />
      )}
      {kind === "image" && (
        <div className="flex h-full items-center justify-center p-4">
          <img
            src={contentUrl}
            alt={file.name}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      )}
      {kind === "html" && <HtmlPreview contentUrl={contentUrl} />}
      {(kind === "text" || kind === "csv") && (
        <FileTextPreview contentUrl={contentUrl} asTable={kind === "csv"} />
      )}
      {kind === "unsupported" && <UnsupportedPreview file={file} />}
    </div>
  );
}

/** Append a cache-busting nonce so a re-fetch sees post-save bytes. */
function withReload(url: string, nonce: number): string {
  if (nonce === 0 || !url) return url;
  return `${url}${url.includes("?") ? "&" : "?"}_r=${nonce}`;
}

/**
 * In-place editor for a `.md`/`.txt` file: loads the current bytes as text,
 * seeds a textarea, and saves the whole content back through the artifact-content
 * route. Byte-counted against the same cap the backend enforces. On success the
 * parent reloads the preview's bytes.
 */
function FileContentEditor({
  fileId,
  contentUrl,
  onSaved,
  onCancel,
}: {
  fileId: string;
  contentUrl: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { text, failed } = useFileText(contentUrl);
  const update = useUpdateFileContent();
  const [draft, setDraft] = useState<string | null>(null);

  // Seed the draft once, from the loaded bytes (an empty file is valid content).
  useEffect(() => {
    if (text !== null)
      setDraft((current) => (current === null ? text : current));
  }, [text]);

  if (failed) {
    return (
      <p className="p-4 text-xs text-muted-foreground">
        Failed to load the file for editing.
      </p>
    );
  }
  if (draft === null) {
    return <p className="p-4 text-xs text-muted-foreground">Loading…</p>;
  }

  return (
    <PlainTextEditor
      value={draft}
      onChange={(value) => setDraft(value)}
      // Files are bounded by stored byte size, not character count.
      count={new TextEncoder().encode(draft).length}
      max={EDITABLE_TEXT_FILE_MAX_BYTES}
      saving={update.isPending}
      onSave={async () => {
        const ok = await update.mutateAsync({ fileId, content: draft });
        if (ok) onSaved();
      }}
      onCancel={onCancel}
    />
  );
}

// === internal components ===

/** Shown when a previewable text file has zero bytes (a valid, empty file). */
function EmptyFileNotice() {
  return (
    <p className="p-4 text-xs text-muted-foreground">This file is empty.</p>
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
  // An empty file is a real, valid file — render an explicit notice rather than
  // the artifact panel's "No artifact yet" placeholder, which reads as missing.
  if (text === "") {
    return <EmptyFileNotice />;
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

/**
 * HTML rendered in a sandboxed iframe. `allow-scripts` WITHOUT
 * `allow-same-origin` runs the document in an opaque origin: scripts execute
 * (so generated pages actually work) but cannot reach our origin's cookies,
 * storage, or DOM. The bytes endpoint deliberately refuses to serve HTML
 * inline, so the markup is fetched as text and injected via srcDoc.
 */
function HtmlPreview({ contentUrl }: { contentUrl: string }) {
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
    <iframe
      title="HTML preview"
      sandbox="allow-scripts"
      srcDoc={text}
      className="h-full min-h-72 w-full border-0 bg-white"
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
  if (text === "") {
    return <EmptyFileNotice />;
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

function UnsupportedPreview({ file }: { file: PreviewableFile }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center">
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

/** Short uppercase tag from a filename extension (e.g. "chart.png" → "PNG"). */
function fileTag(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "FILE";
  return name
    .slice(dot + 1)
    .toUpperCase()
    .slice(0, 4);
}

/**
 * Full-height right-side preview panel — the same reading experience as the
 * chat Files sidebar, for pages without one (My Files, project pages).
 */
export function FilePreviewSheet({
  file,
  onClose,
}: {
  file: PreviewableFile | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={file !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl"
      >
        <SheetHeader className="border-b px-4 py-3">
          <SheetTitle className="flex min-w-0 items-center gap-2 pr-8 text-sm">
            <span className="min-w-0 flex-1 truncate">{file?.name}</span>
            {file && (
              <a
                href={file.contentUrl}
                download={file.name}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                aria-label={`Download ${file.name}`}
              >
                <Download className="h-4 w-4" />
              </a>
            )}
          </SheetTitle>
        </SheetHeader>
        {file && <FilePreview file={file} onClose={onClose} />}
      </SheetContent>
    </Sheet>
  );
}
