"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type PreviewableSourceText = {
  label: string;
  text: string;
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
          <p className="whitespace-pre-wrap text-sm">{source.text}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
