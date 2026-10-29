"use client";

import { ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { DiffEditor } from "@/components/diff-editor";
import { Editor } from "@/components/editor";
import { LazyMount } from "@/components/lazy-mount";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { cn } from "@/lib/utils/tailwind";
import { ADDED_TEXT, HUNK_MARKER_TEXT } from "./tones";

/** How a hunk moved. An edit is tagged with git's word for it, "modified". */
export type HunkChange = "added" | "removed" | "changed";

/**
 * The scrolling body that holds a version's hunks. The next version is
 * sometimes on its way while this one stays readable underneath, so the body
 * recedes rather than emptying out.
 */
export function HunkScrollArea({
  isStale,
  children,
}: {
  isStale: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-hunk-scroll
      aria-busy={isStale}
      className={cn(
        "min-h-0 flex-1 overflow-y-auto px-6 py-5 transition-opacity",
        isStale && "opacity-55",
      )}
    >
      {children}
    </div>
  );
}

/** Scroll the hunk with `id` to the top of the scroll area `from` sits in. */
export function scrollToHunk(from: HTMLElement, id: string) {
  const reduceMotion = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  from
    .closest("[data-hunk-scroll]")
    ?.querySelector(`[data-hunk="${CSS.escape(id)}"]`)
    ?.scrollIntoView?.({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    });
}

/**
 * One section or file, headed like a diff hunk — `@@ System prompt @@` — with
 * its own stat, what happened to it, and a fold. Folding is per hunk and
 * resets with the version, which remounts it.
 */
export function HunkBlock({
  id,
  label,
  prefix,
  stat,
  change,
  children,
}: {
  id: string;
  /** The hunk's name, and its accessible name. */
  label: string;
  /** A muted lead-in before the name, such as the group a hook sits in. */
  prefix?: string;
  stat: ReactNode;
  change: HunkChange | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section
      aria-label={label}
      data-hunk={id}
      className="scroll-mt-1 overflow-hidden rounded-md border bg-background"
    >
      <UnstyledButton
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 bg-muted/45 px-3 py-[7px] text-left font-mono text-xs transition-colors hover:bg-muted/75 focus-visible:bg-muted/75 focus-visible:outline-none",
          open && "border-b",
        )}
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span aria-hidden className={cn("shrink-0", HUNK_MARKER_TEXT)}>
          @@
        </span>
        <span className="min-w-0 truncate font-medium">
          {prefix ? (
            <span className="text-muted-foreground">{`${prefix} / `}</span>
          ) : null}
          <span>{label}</span>
        </span>
        <span aria-hidden className={cn("shrink-0", HUNK_MARKER_TEXT)}>
          @@
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-3">
          {stat}
          {change ? <ChangeTag change={change} /> : null}
        </span>
      </UnstyledButton>
      {open ? children : null}
    </section>
  );
}

/** A hunk's +/− line counts, or what it holds when nothing is compared. */
export function HunkStat({
  added,
  removed,
  edited,
  summary,
}: {
  added?: number;
  removed?: number;
  /** Rows edited in place, for collections (`~2`). */
  edited?: number;
  /** Shown instead of counts, e.g. "12 lines" in the whole-version view. */
  summary?: string;
}) {
  if (summary !== undefined) {
    return <span className="text-[11px] text-muted-foreground">{summary}</span>;
  }
  return (
    <span className="flex gap-1.5 text-[11px] tabular-nums">
      {added ? <span className={ADDED_TEXT}>+{added}</span> : null}
      {removed ? <span className="text-destructive">−{removed}</span> : null}
      {edited ? <span className="text-muted-foreground">~{edited}</span> : null}
    </span>
  );
}

/**
 * One unified-diff line: a sign gutter, an optional key column and a tinted
 * monospace body. `*` marks a setting that moved in this version; `·` is a
 * line read whole.
 */
export function DiffLine({
  sign,
  label,
  muted = false,
  children,
}: {
  sign: "+" | "-" | "~" | "*" | " ";
  label?: string;
  muted?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[2rem_minmax(0,1fr)] font-mono text-xs leading-5",
        sign === "+" && "bg-emerald-500/[0.07]",
        sign === "-" && "bg-destructive/[0.06]",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "py-[3px] text-center select-none",
          sign === "+" && cn("bg-emerald-500/10", ADDED_TEXT),
          sign === "-" && "bg-destructive/10 text-destructive",
          sign === "~" && "bg-muted/60 text-muted-foreground",
          sign === "*" && "text-primary",
          sign === " " && "text-muted-foreground/30",
        )}
      >
        {SIGN_GLYPHS[sign]}
      </span>
      <span
        className={cn(
          "min-w-0 py-[3px] pr-3 pl-2 break-words",
          label && "grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-4",
        )}
      >
        {label ? (
          <>
            <span className="truncate text-muted-foreground">{label}</span>
            <span className={cn("min-w-0", muted && "text-muted-foreground")}>
              {children}
            </span>
          </>
        ) : (
          children
        )}
      </span>
    </div>
  );
}

/** A short mono line inside a hunk, for bodies with nothing to draw. */
export function HunkNote({ children }: { children: ReactNode }) {
  return (
    <p className="px-3.5 py-3 font-mono text-xs text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * A text body in Monaco: read whole, or as a unified diff against the
 * baseline. Stacked in one scroll pane, an editor has no parent height to
 * fill, so it is sized to its content and capped so one long body does not
 * swallow the pane (past the cap it scrolls internally). Each one mounts only
 * when scrolled to — a version can carry many.
 */
export function HunkEditor({
  language,
  value,
  original,
}: {
  language: string;
  value: string;
  /** The baseline's text; set to render a diff rather than the text whole. */
  original?: string;
}) {
  const height = editorHeight(value, original ?? null);
  return (
    <LazyMount height={height}>
      {original === undefined ? (
        <Editor
          height={height}
          language={language}
          value={value}
          options={{
            readOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
          }}
        />
      ) : (
        <DiffEditor
          height={height}
          language={language}
          original={original}
          modified={value}
          options={{
            // A unified diff fits the pane; side-by-side would halve the width
            // for each revision.
            renderSideBySide: false,
            // Long, mostly-unchanged bodies collapse to the edited regions.
            hideUnchangedRegions: { enabled: true },
          }}
        />
      )}
    </LazyMount>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

const SIGN_GLYPHS: Record<"+" | "-" | "~" | "*" | " ", string> = {
  "+": "+",
  "-": "−",
  "~": "~",
  "*": "*",
  " ": "·",
};

function ChangeTag({ change }: { change: HunkChange }) {
  return (
    <span
      className={cn(
        "rounded-[3px] border px-1.5 text-[10px] leading-4",
        change === "added" &&
          cn("border-emerald-500/30 bg-emerald-500/[0.08]", ADDED_TEXT),
        change === "removed" &&
          "border-destructive/30 bg-destructive/[0.08] text-destructive",
        change === "changed" && "border-border text-muted-foreground",
      )}
    >
      {change === "changed" ? "modified" : change}
    </span>
  );
}

/**
 * A content-sized editor height in pixels: the longer side's line count at
 * Monaco's default line height plus a little padding, clamped so a one-liner
 * still reads as a text block and a long body does not take the whole pane.
 */
function editorHeight(current: string, previous: string | null): number {
  const lines = Math.max(
    current.split("\n").length,
    (previous ?? "").split("\n").length,
  );
  return Math.min(Math.max(lines * 19 + 24, 96), 400);
}
