"use client";

import { Download } from "lucide-react";
import { FilePreview } from "@/components/chat/file-preview";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Anything the dialog can show: a display name, a mime, a byte endpoint. */
export type PreviewableDocument = {
  name: string;
  mimeType: string;
  contentUrl: string;
};

/**
 * A modal wrapper around `FilePreview`, for surfaces where files live in a
 * table rather than a panel — the knowledge repository, batch-analysis rows.
 * PDFs render in the browser's own viewer; markdown, images, text and CSV get
 * the same treatment as the chat Files panel; anything else offers a download.
 */
export function FilePreviewDialog({
  open,
  onOpenChange,
  file,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file?: PreviewableDocument;
}) {
  if (!file) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-w-4xl flex-col gap-0 p-0 sm:max-w-4xl">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <div className="flex items-center gap-2 pr-8">
            <DialogTitle className="min-w-0 flex-1 truncate text-base">
              {file.name}
            </DialogTitle>
            <a
              href={file.contentUrl}
              download={file.name}
              title={`Download ${file.name}`}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Download className="h-4 w-4" />
              <span className="sr-only">Download {file.name}</span>
            </a>
          </div>
          {/* Required by the dialog's a11y contract; visually redundant here. */}
          <DialogDescription className="sr-only">
            Preview of {file.name}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          <FilePreview file={file} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
