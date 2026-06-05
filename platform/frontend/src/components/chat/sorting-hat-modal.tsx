"use client";

import { SparklesIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const DEFAULT_MONOLOGUE = [
  "Hmm... a tool wakes under my brim.",
  "A house will rise from risk and whim.",
  "The choice is near.",
];

export function getSortingHatSessionKey(conversationId?: string): string {
  return `sorting-hat:first-tool:${conversationId ?? "new"}`;
}

export function SortingHatModal({
  conversationId,
  hasToolInvocation,
  monologue,
}: {
  conversationId?: string;
  hasToolInvocation: boolean;
  monologue?: string[];
}) {
  const [open, setOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(0);
  const chunks = useMemo(
    () => (monologue && monologue.length > 0 ? monologue : DEFAULT_MONOLOGUE),
    [monologue],
  );

  useEffect(() => {
    if (!hasToolInvocation || typeof window === "undefined") return;
    const key = getSortingHatSessionKey(conversationId);
    if (window.sessionStorage.getItem(key)) return;
    window.sessionStorage.setItem(key, "shown");
    setVisibleCount(0);
    setOpen(true);
  }, [conversationId, hasToolInvocation]);

  useEffect(() => {
    if (!open || visibleCount >= chunks.length) return;
    const timeout = window.setTimeout(
      () => setVisibleCount((count) => count + 1),
      240,
    );
    return () => window.clearTimeout(timeout);
  }, [chunks.length, open, visibleCount]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SparklesIcon className="size-5" />
            Sorting Hat
          </DialogTitle>
          <DialogDescription>
            The first tool call in this chat is being sorted.
          </DialogDescription>
        </DialogHeader>
        <div aria-live="polite" className="min-h-24 space-y-2 text-sm">
          {chunks.slice(0, visibleCount).map((chunk) => (
            <p key={chunk}>{chunk}</p>
          ))}
          {visibleCount < chunks.length ? (
            <span className="inline-block h-4 w-2 animate-pulse rounded-sm bg-muted-foreground" />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
