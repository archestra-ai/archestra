"use client";

import { Maximize2 } from "lucide-react";
import { useMemo } from "react";
import { TRUNCATED_CONTENT_MAX_LINES } from "@/components/ai-elements/truncated-content";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils/tailwind";
import { PolicyDiffReview } from "./policy-diff-review";
import type { PolicyDiffRow } from "./policy-diff-rows";

/** Keep chat bounded; the full review virtualizes even a whole-policy rewrite. */
export function PolicyDiff({
  rows,
  before,
  after,
  path,
}: {
  rows: PolicyDiffRow[];
  before: string;
  after: string;
  path: string;
}) {
  const { added, removed, digits } = useMemo(() => {
    let added = 0;
    let removed = 0;
    let lastLine = 1;
    for (const row of rows) {
      if (row.kind === "add") added++;
      if (row.kind === "remove") removed++;
      if (row.kind !== "gap" && row.line !== null) lastLine = row.line;
    }
    return { added, removed, digits: String(lastLine).length };
  }, [rows]);
  const hidden = Math.max(0, rows.length - TRUNCATED_CONTENT_MAX_LINES);
  const summary = (
    <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums">
      <span className="text-emerald-800 dark:text-emerald-300">
        {added.toLocaleString()} added
      </span>
      <span className="text-destructive">
        {removed.toLocaleString()} removed
      </span>
    </span>
  );

  return (
    <Dialog>
      <section
        aria-label="Policy diff"
        className="min-w-0 overflow-hidden rounded-md border border-border/50 bg-background"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
          {summary}
          <DialogTrigger asChild>
            <Button variant="outline" size="xs">
              <Maximize2 />
              <span>Review full diff</span>
            </Button>
          </DialogTrigger>
        </div>
        <section
          className="max-h-80 overflow-auto overscroll-contain py-1 font-mono text-xs leading-5"
          aria-label="Diff preview"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users must be able to scroll the preview
          tabIndex={0}
        >
          {rows.slice(0, TRUNCATED_CONTENT_MAX_LINES).map((row, index) => (
            <PolicyDiffLine
              // biome-ignore lint/suspicious/noArrayIndexKey: static, ordered preview rows
              key={index}
              row={row}
              digits={digits}
            />
          ))}
          {rows.length === 0 && (
            <p className="px-3 py-2 font-sans text-muted-foreground">
              No changes to display.
            </p>
          )}
        </section>
        {hidden > 0 && (
          <div className="border-t px-3 py-2 text-xs text-muted-foreground">
            {hidden.toLocaleString()} more diff lines in the full review
          </div>
        )}
      </section>
      {/* An immersive editor needs its own fixed-height shell and scroll area. */}
      <DialogContent
        className="h-[90dvh] w-[calc(100%-2rem)] max-w-[100rem] gap-0"
        onEscapeKeyDown={(event) => {
          // Radix sees Escape before Monaco does. Let the editor close its
          // search widget without also dismissing the policy review.
          if (
            event.target instanceof Element &&
            event.target.closest(".find-widget")
          ) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader className="shrink-0 gap-2 pr-12 text-left">
          <DialogTitle>Policy changes</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            {path}
          </DialogDescription>
          {summary}
        </DialogHeader>
        <PolicyDiffReview before={before} after={after} path={path} />
      </DialogContent>
    </Dialog>
  );
}

function PolicyDiffLine({
  row,
  digits,
}: {
  row: PolicyDiffRow;
  digits: number;
}) {
  if (row.kind === "gap") {
    return (
      <div className="bg-muted/40 px-3 font-sans text-muted-foreground">
        <span aria-hidden>···</span>
        <span className="sr-only">Unchanged lines hidden</span>
      </div>
    );
  }
  return (
    <div
      className={cn(
        "flex",
        row.kind === "add" && "bg-emerald-500/10",
        row.kind === "remove" && "bg-destructive/10",
      )}
    >
      <span
        className="shrink-0 select-none whitespace-nowrap pr-2 text-right text-muted-foreground"
        style={{ width: `${Math.max(3, digits) + 2}ch` }}
      >
        {row.line ?? ""}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 whitespace-pre-wrap border-l-[3px] border-transparent px-2 [overflow-wrap:anywhere]",
          row.kind === "add" &&
            "border-emerald-600 text-emerald-800 dark:text-emerald-300",
          row.kind === "remove" && "border-destructive text-destructive",
        )}
      >
        {row.kind === "add" ? (
          <span className="sr-only">Added: </span>
        ) : row.kind === "remove" ? (
          <span className="sr-only">Removed: </span>
        ) : null}
        <span>{row.text || " "}</span>
      </span>
    </div>
  );
}
