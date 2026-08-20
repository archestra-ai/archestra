"use client";

import { DocsPage, getDocsUrl } from "@archestra/shared";
import { Info, Settings2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const DISMISSED_STORAGE_PREFIX = "knowledge-document-ocr-notice-dismissed";

/**
 * Quiet note for a source that carries PDFs while Document OCR is not set up:
 * scanned or image-only pages are skipped at sync, so their text never becomes
 * searchable. Sibling of {@link EmbeddingModelImageSupportNotice}, which covers
 * the other kind of visual content (image files) — the two stack when both
 * apply, each with its own settings link and dismissal.
 *
 * Dismissal is per `dismissalScope` (organization + user) and is cleared
 * whenever OCR is seen configured, so an admin who later clears the OCR
 * configuration is told again — mirroring how the image note returns when the
 * embedding model changes.
 */
export function DocumentOcrNotice({
  ocrConfigured,
  dismissalScope,
  className,
}: {
  ocrConfigured: boolean;
  dismissalScope: string;
  className?: string;
}) {
  const storageKey = `${DISMISSED_STORAGE_PREFIX}:${dismissalScope}`;
  // null until the stored dismissal has been read, so the note never flashes
  // on for a user who dismissed it.
  const [dismissed, setDismissed] = useState<boolean | null>(null);

  useEffect(() => {
    if (ocrConfigured) {
      clearDismissed(storageKey);
      setDismissed(null);
      return;
    }
    setDismissed(readDismissed(storageKey));
  }, [ocrConfigured, storageKey]);

  if (ocrConfigured || dismissed !== false) {
    return null;
  }

  const handleDismiss = () => {
    writeDismissed(storageKey);
    setDismissed(true);
  };

  return (
    <div
      role="note"
      className={cn(
        "flex flex-col gap-3 rounded-md border border-border/60 bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground sm:flex-row sm:items-center",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <Info className="mt-0.5 size-4 shrink-0" />
        <p className="leading-relaxed">
          <span className="font-medium text-foreground">
            Document OCR is not set up.
          </span>{" "}
          Scanned or image-only PDF pages in this source are skipped, so their
          text is not searchable.{" "}
          <ExternalDocsLink
            href={getDocsUrl(DocsPage.PlatformKnowledge, "document-ocr")}
            className="text-foreground underline decoration-dotted underline-offset-4 hover:decoration-solid"
            showIcon={false}
          >
            Learn more
          </ExternalDocsLink>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
        <Button variant="outline" size="sm" asChild>
          <Link href="/settings/knowledge#document-ocr">
            <Settings2 className="size-3.5" />
            <span>OCR settings</span>
          </Link>
        </Button>
        <Button variant="ghost" size="sm" onClick={handleDismiss}>
          <span>Dismiss</span>
        </Button>
      </div>
    </div>
  );
}

function readDismissed(storageKey: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(storageKey) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(storageKey: string) {
  try {
    localStorage.setItem(storageKey, "1");
  } catch {
    // Keep the in-memory dismissal when browser storage is unavailable.
  }
}

function clearDismissed(storageKey: string) {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    // A blocked storage backend is already equivalent to no persisted dismissal.
  }
}
