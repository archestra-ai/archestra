"use client";

import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";
import { scrollToHunk } from "./hunk-block";
import { ADDED_TEXT } from "./tones";

/** One row of the stat table: a section or a file, and its line weight. */
export interface DiffStatRow {
  /** The hunk the row jumps to. */
  id: string;
  path: string;
  added: number;
  removed: number;
  /** `git diff --name-status` letter, for histories made of files. */
  status?: "A" | "M" | "D";
}

/**
 * A literal `git diff --stat`: a row per thing that moved, its count and a
 * `+++--` bar scaled to the heaviest row, then the totals line. Each row jumps
 * to its hunk below.
 */
export function DiffStatTable({
  rows,
  unit,
}: {
  rows: DiffStatRow[];
  /** What a row is, singular: "section", "file". */
  unit: string;
}) {
  const heaviest = Math.max(1, ...rows.map((row) => row.added + row.removed));
  const scale = heaviest > BAR_MAX ? BAR_MAX / heaviest : 1;
  const added = rows.reduce((sum, row) => sum + row.added, 0);
  const removed = rows.reduce((sum, row) => sum + row.removed, 0);
  const hasStatus = rows.some((row) => row.status);

  return (
    <div className="overflow-hidden rounded-md border bg-muted/20 py-2 font-mono text-xs">
      <div
        className={cn(
          "grid",
          hasStatus
            ? "grid-cols-[auto_minmax(0,max-content)_auto_minmax(0,1fr)]"
            : "grid-cols-[minmax(0,max-content)_auto_minmax(0,1fr)]",
        )}
      >
        {rows.map((row) => (
          <UnstyledButton
            key={row.id}
            onClick={(event) => scrollToHunk(event.currentTarget, row.id)}
            className={cn(
              "grid cursor-pointer grid-cols-subgrid items-center px-4 py-[3px] text-left transition-colors hover:bg-muted/70 focus-visible:bg-muted/70 focus-visible:outline-none",
              hasStatus ? "col-span-4" : "col-span-3",
            )}
          >
            {hasStatus ? (
              <span
                className={cn(
                  "pr-3 font-semibold",
                  row.status === "A" && ADDED_TEXT,
                  row.status === "D" && "text-destructive",
                  row.status === "M" && "text-muted-foreground",
                )}
              >
                {row.status ?? " "}
              </span>
            ) : null}
            <span className="truncate pr-4 text-foreground/90">{row.path}</span>
            <span className="flex items-center gap-2 pr-2 tabular-nums">
              <span className="text-muted-foreground/50">|</span>
              <span className="min-w-[2ch] text-right text-muted-foreground">
                {row.added + row.removed}
              </span>
            </span>
            <span className="truncate tracking-[0.06em]" aria-hidden>
              <span className={ADDED_TEXT}>
                {"+".repeat(barLength(row.added, scale))}
              </span>
              <span className="text-destructive">
                {"-".repeat(barLength(row.removed, scale))}
              </span>
            </span>
          </UnstyledButton>
        ))}
      </div>
      <p className="mt-1 px-4 text-muted-foreground">
        <span>{`${rows.length} ${rows.length === 1 ? unit : `${unit}s`} changed, `}</span>
        <span className={ADDED_TEXT}>
          {`${added} ${added === 1 ? "insertion" : "insertions"}(+)`}
        </span>
        <span>, </span>
        <span className="text-destructive">
          {`${removed} ${removed === 1 ? "deletion" : "deletions"}(-)`}
        </span>
      </p>
    </div>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

/** The widest bar, in characters; heavier rows are scaled down to it. */
const BAR_MAX = 32;

/** A side's bar length: scaled, but never hidden when the side moved at all. */
function barLength(count: number, scale: number): number {
  if (count === 0) return 0;
  return Math.max(1, Math.round(count * scale));
}
