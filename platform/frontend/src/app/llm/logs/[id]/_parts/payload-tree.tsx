"use client";

import { type MouseEvent, useCallback, useMemo } from "react";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import "react18-json-view/src/dark.css";
import "./payload-tree.css";
import { branchesToOpen } from "./payload-open";
import { formatByteSize, jsonByteSize } from "./payload-size";

/**
 * A logged payload as a collapsible tree, with each branch's size beside it.
 * It opens as many levels as fit a first read of about `FIRST_READ_ROWS`
 * rows, so a small payload opens whole. Folded branches render nothing, so a
 * multi-megabyte request still opens in a moment.
 */
export function PayloadTree({ value }: { value: unknown }) {
  const open = useMemo(() => branchesToOpen(value, FIRST_READ_ROWS), [value]);
  // Stable, because the tree re-applies its initial folds, undoing the
  // reader's, whenever this changes.
  const collapsed = useCallback(
    ({ node }: { node: unknown }) => !open.has(node as object),
    [open],
  );
  return (
    // Strings keep their line breaks, so an opened tool result or prompt
    // reads like the text it holds. The left padding is the root chevron's
    // gutter.
    // biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut; each branch's own fold button stays the keyboard path
    // biome-ignore lint/a11y/useKeyWithClickEvents: as above
    <div
      className="payload-tree rounded-lg border bg-background py-2 pr-3 pl-6 font-mono text-xs leading-5 [&_.json-view--string]:[overflow-wrap:anywhere] [&_.json-view--string]:whitespace-pre-wrap"
      onClick={toggleBranchFromRow}
    >
      <JsonView
        src={value}
        collapsed={collapsed}
        collapseStringsAfterLength={STRING_PREVIEW_LENGTH}
        CustomOperation={BranchSummary}
      />
    </div>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

const STRING_PREVIEW_LENGTH = 200;

/** A few screens of the pane: enough to read, short enough to scan. */
const FIRST_READ_ROWS = 100;

/** Branches under 1 KB show no size, so the sizes that matter stand out. */
const MIN_SIZED_BYTES = 1024;

/** A branch row: the root, a key/value pair, or a large array's group. */
const BRANCH_ROW = ".json-view, .json-view--pair, .jv-indent > div";

/**
 * Lets the gutter chevron, a branch's key name and its summary fold and open
 * it, by pressing the branch's own toggle: the fold button while folded, the
 * library's (hidden) chevron while open.
 */
function toggleBranchFromRow(event: MouseEvent<HTMLDivElement>) {
  const target = event.target as HTMLElement;
  const row = target.closest<HTMLElement>(BRANCH_ROW);
  if (!row) return;
  const onKey =
    target.parentElement === row &&
    target.matches(".json-view--property, .json-view--index");
  const onSummary =
    target.closest("[data-branch-summary]")?.parentElement === row;
  // The chevron is the row's ::before, drawn in the gutter left of the row.
  const onChevron =
    target === row && event.clientX < row.getBoundingClientRect().left;
  if (!onKey && !onSummary && !onChevron) return;
  row
    .querySelector<HTMLElement>(
      ":scope > .jv-button, :scope > .jv-size-chevron",
    )
    ?.click();
}

/** How many entries a branch holds and, when it is sizeable, its weight. */
function BranchSummary({ node }: { node: unknown }) {
  // The tree offers this slot beside values too; only branches get a summary.
  if (node === null || typeof node !== "object") return null;
  const count = Array.isArray(node) ? node.length : Object.keys(node).length;
  const noun = Array.isArray(node) ? "item" : "key";
  const bytes = jsonByteSize(node);
  const entries = `${count} ${count === 1 ? noun : `${noun}s`}`;
  return (
    <span
      data-branch-summary
      className="mx-1.5 text-[11px] text-muted-foreground tabular-nums"
    >
      {bytes >= MIN_SIZED_BYTES
        ? `${entries} · ${formatByteSize(bytes)}`
        : entries}
    </span>
  );
}
