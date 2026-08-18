"use client";

import { splitOnQuote } from "@/components/chat/file-preview";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type PreviewableSourceText = {
  label: string;
  text: string;
  /** A verbatim span to highlight and scroll to. */
  highlightQuote?: string;
};

/**
 * Shows a pasted-text source in full. File-backed rows open the real file in
 * the file preview; this is the equivalent for rows whose source is text the
 * user pasted in — without it there is no way to see what a row's answers were
 * generated from.
 */
export function SourceTextDialog({
  open,
  onOpenChange,
  source,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source?: PreviewableSourceText;
}) {
  if (!source) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <DialogTitle className="min-w-0 truncate pr-8 text-base">
            {source.label}
          </DialogTitle>
        </DialogHeader>
        <div className="overflow-y-auto px-4 py-3">
          <SourceBody
            text={source.text}
            highlightQuote={source.highlightQuote}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SourceBody({
  text,
  highlightQuote,
}: {
  text: string;
  highlightQuote?: string;
}) {
  const parts = highlightQuote ? splitOnQuote(text, highlightQuote) : null;
  if (!parts) {
    return <p className="whitespace-pre-wrap text-sm">{text}</p>;
  }
  return (
    <p className="whitespace-pre-wrap text-sm">
      {/* Spans, not bare text nodes — machine-translation safety. */}
      <span>{parts.before}</span>
      <mark
        ref={(el) => el?.scrollIntoView({ block: "center" })}
        className="rounded-sm bg-yellow-200 px-0.5 dark:bg-yellow-500/40"
      >
        {parts.match}
      </mark>
      <span>{parts.after}</span>
    </p>
  );
}
