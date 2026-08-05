"use client";

import { Button } from "@/components/ui/button";

/**
 * A read that failed, offered with a way to try again. Kept distinct from the
 * "no such version" copy on purpose: a transport failure supports no claim
 * about what the history holds, so it must not be phrased as one.
 */
export function LoadFailure({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    // Sized to content rather than to the column: this renders both in the
    // 12rem timeline and across the full width of the preview pane.
    <div className="flex flex-col items-start gap-2 px-3 py-3">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
