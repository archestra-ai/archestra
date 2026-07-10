import { ApiError } from "@/types";

/**
 * Provider-agnostic str_replace edit engine, shared by the app and skill
 * authoring tools. It applies ordered `{ old_str, new_str }` edits to a source
 * string with a unique-match requirement, a whitespace-insensitive fallback,
 * no-op skipping, and atomic-abort semantics — the caller's user-facing noun
 * (`sourceNoun`) and recovery hint (`rereadHint`) are injected so this module
 * stays free of app- or skill-specific terminology.
 */

type StrReplaceEdit = { old_str: string; new_str: string };

export type AppliedEditSpan = {
  start: number;
  end: number;
  laterModified: boolean;
  // The caller's 1-based edit number, so excerpt labels stay aligned with the
  // submitted batch even when an earlier edit was skipped.
  editNumber: number;
};

export type SkippedEdit = { editNumber: number; reason: string };

type StrReplaceLabels = {
  /** Names the edited artifact in error messages, e.g. "HTML", "SKILL.md". */
  sourceNoun: string;
  /** Recovery sentence for a 0-match with no whitespace-recoverable span. */
  rereadHint: string;
};

/**
 * Apply ordered str_replace edits to a document. Each `old_str` must occur
 * exactly once in the running text; 0 or >1 matches throws `ApiError(400)`
 * naming the offending edit, so the whole call fails before any version is
 * created. A no-op edit (`old_str === new_str`) is skipped, not fatal: it is
 * reported in `skipped` (by the caller's 1-based edit number) while the rest of
 * the batch applies.
 */
export function applyStrReplaceEdits(
  source: string,
  edits: StrReplaceEdit[],
  labels: StrReplaceLabels,
): { content: string; spans: AppliedEditSpan[]; skipped: SkippedEdit[] } {
  let working = source;
  // One span per applied edit, kept in FINAL-document coordinates: each later
  // replacement shifts the earlier spans it lands before, and a replacement
  // that overlaps an earlier span re-points that span at its own region (marked
  // laterModified) — so an excerpt built from a span never shows text a later
  // edit removed.
  const spans: AppliedEditSpan[] = [];
  const skipped: SkippedEdit[] = [];
  const applyAt = (params: {
    start: number;
    oldLength: number;
    newStr: string;
    editNumber: number;
  }) => {
    const { start, oldLength, newStr, editNumber } = params;
    working =
      working.slice(0, start) + newStr + working.slice(start + oldLength);
    const end = start + newStr.length;
    const delta = newStr.length - oldLength;
    for (const span of spans) {
      if (span.end <= start) continue;
      if (span.start >= start + oldLength) {
        span.start += delta;
        span.end += delta;
      } else {
        span.laterModified = true;
        span.start = start;
        span.end = end;
      }
    }
    spans.push({ start, end, laterModified: false, editNumber });
  };
  edits.forEach((edit, index) => {
    const editNumber = index + 1;
    const label = `edit ${editNumber}`;
    if (edit.old_str === edit.new_str) {
      skipped.push({
        editNumber,
        reason: "old_str and new_str are identical (no-op).",
      });
      return;
    }
    const count = countOccurrences(working, edit.old_str);
    if (count === 0) {
      // Formatting drift (a re-indented or re-wrapped copy) is the common cause
      // of a 0-match. If the text still matches uniquely once whitespace runs
      // are collapsed, apply the edit at that exact span rather than failing —
      // the model's intent is unambiguous. A genuine content mismatch (a typo
      // in a non-whitespace character) stays a hard error below.
      const span = findWhitespaceInsensitiveSpan(working, edit.old_str);
      if (span) {
        applyAt({
          start: span.start,
          oldLength: span.end - span.start,
          newStr: edit.new_str,
          editNumber,
        });
        return;
      }
      const hint =
        describeNearMiss(working, edit.old_str, labels.sourceNoun) ??
        labels.rereadHint;
      throw new ApiError(
        400,
        `${label}: old_str not found in the current ${labels.sourceNoun} (0 matches). ${hint}`,
      );
    }
    if (count > 1) {
      throw new ApiError(
        400,
        `${label}: old_str matched ${count} times; it must match exactly once. Add surrounding context to make it unique.`,
      );
    }
    applyAt({
      start: working.indexOf(edit.old_str),
      oldLength: edit.old_str.length,
      newStr: edit.new_str,
      editNumber,
    });
  });
  return { content: working, spans, skipped };
}

// Bounds for the applied-edit context block on a successful edit: enough to
// verify a change landed without re-reading the source, small enough to never
// rival the document itself.
const EDIT_EXCERPT_CONTEXT_CHARS = 150;
const EDIT_EXCERPT_SPAN_MAX_CHARS = 600;
const EDIT_EXCERPT_MAX_EDITS = 5;

/**
 * Per-edit windows into the final saved document, so the model can verify its
 * edits without a follow-up read. Spans arrive in final-document coordinates
 * from applyStrReplaceEdits; overlong inserted text is elided in the middle and
 * window truncation is marked with `…`.
 */
export function buildAppliedEditExcerpts(
  content: string,
  spans: AppliedEditSpan[],
): string {
  const shown = spans.slice(0, EDIT_EXCERPT_MAX_EDITS);
  const blocks = shown.map((span) => {
    const beforeStart = Math.max(0, span.start - EDIT_EXCERPT_CONTEXT_CHARS);
    const afterEnd = Math.min(
      content.length,
      span.end + EDIT_EXCERPT_CONTEXT_CHARS,
    );
    const before = `${beforeStart > 0 ? "…" : ""}${content.slice(beforeStart, span.start)}`;
    const after = `${content.slice(span.end, afterEnd)}${afterEnd < content.length ? "…" : ""}`;
    const body =
      span.start === span.end
        ? "⟦deleted⟧"
        : capHint(
            content.slice(span.start, span.end),
            EDIT_EXCERPT_SPAN_MAX_CHARS,
          );
    const notes = [
      ...(span.start === span.end ? ["deletion point"] : []),
      ...(span.laterModified ? ["region modified by a later edit"] : []),
    ];
    const label = `edit ${span.editNumber}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
    return `${label}:\n${before}${body}${after}`;
  });
  const omitted = spans.length - shown.length;
  const omittedNote =
    omitted > 0
      ? `\n(+${omitted} more edit${omitted === 1 ? "" : "s"} applied, not shown)`
      : "";
  return `\nApplied-edit context (from the saved document — no need to re-read to verify):\n${blocks.join("\n")}${omittedNote}`;
}

export function formatSkippedEditsNote(skipped: SkippedEdit[]): string {
  return skipped.length > 0
    ? `\nSkipped edits (not applied):\n- ${skipped.map((s) => `edit ${s.editNumber} skipped: ${s.reason}`).join("\n- ")}`
    : "";
}

/** Cap a span shown in an error hint, eliding the middle of an overlong one. */
function capHint(span: string, max = 1500): string {
  if (span.length <= max) return span;
  const half = Math.floor((max - 20) / 2);
  return `${span.slice(0, half)}\n…[elided]…\n${span.slice(span.length - half)}`;
}

// Count every start position where `needle` matches, including overlapping ones
// (e.g. "\n\n" twice in "\n\n\n"). The edit path uses this to enforce a unique
// match, so a self-overlapping old_str must read as ambiguous — not collapse to
// one and silently replace the first occurrence. Advance by one position.
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let pos = haystack.indexOf(needle);
  while (pos !== -1) {
    count++;
    pos = haystack.indexOf(needle, pos + 1);
  }
  return count;
}

/**
 * Collapse each run of whitespace in `s` to a single space, returning the
 * normalized text plus a map from each normalized code-unit index to the
 * original index it began at (a collapsed space maps to its run's first char).
 * Operates on JS code units so the map composes with the `indexOf`/`slice` the
 * edit path already uses.
 */
function normalizeWhitespace(s: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) {
      const runStart = i;
      while (i < s.length && /\s/.test(s[i])) i++;
      text += " ";
      map.push(runStart);
    } else {
      text += s[i];
      map.push(i);
      i++;
    }
  }
  return { text, map };
}

/**
 * Locate `oldStr` in `haystack` ignoring differences in whitespace runs, so an
 * edit whose old_str drifted only in indentation or line-wrapping still applies.
 * Returns the exact original-byte span (the replacement then preserves the real
 * surrounding text) only when the whitespace-normalized needle matches exactly
 * once; returns null when it is absent or ambiguous, leaving the strict 0/>1
 * match errors to fire.
 */
function findWhitespaceInsensitiveSpan(
  haystack: string,
  oldStr: string,
): { start: number; end: number } | null {
  const needle = oldStr.replace(/\s+/g, " ").trim();
  if (needle.length === 0) return null;
  const norm = normalizeWhitespace(haystack);
  const first = norm.text.indexOf(needle);
  if (first === -1) return null;
  if (norm.text.indexOf(needle, first + needle.length) !== -1) return null;
  const start = norm.map[first];
  const afterIdx = first + needle.length;
  const end = afterIdx < norm.map.length ? norm.map[afterIdx] : haystack.length;
  return { start, end };
}

/**
 * Best-effort, advisory recovery hint when an `old_str` matched 0 times and was
 * not whitespace-recoverable either (a genuine content mismatch, not just
 * reformatting): anchor the model at the nearest ground-truth line so it copies
 * the real current text instead of replaying a corrupted literal. Never changes
 * match semantics — returns a hint sentence or null.
 */
function describeNearMiss(
  haystack: string,
  oldStr: string,
  sourceNoun: string,
): string | null {
  // Anchor window — the longest line of old_str that occurs exactly once in
  // the current source anchors a ±3-line window of ground truth, so a one-char
  // drift elsewhere in the block is visible against the real source.
  const anchors = oldStr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 8)
    .sort((a, b) => b.length - a.length);
  for (const anchor of anchors) {
    const first = haystack.indexOf(anchor);
    if (first === -1) continue;
    if (haystack.indexOf(anchor, first + anchor.length) !== -1) continue;
    const window = lineWindowAround(haystack, first, 3);
    return `The closest unique anchor from your old_str appears here in the current ${sourceNoun} (±3 lines); re-copy the exact current text:\n${capHint(window)}`;
  }
  return null;
}

/** The text of the line containing `at` in `s`, plus `radius` lines on each side. */
function lineWindowAround(s: string, at: number, radius: number): string {
  let start = s.lastIndexOf("\n", at - 1) + 1;
  for (let k = 0; k < radius && start > 0; k++) {
    start = s.lastIndexOf("\n", start - 2) + 1;
  }
  let end = s.indexOf("\n", at);
  if (end === -1) end = s.length;
  for (let k = 0; k < radius && end < s.length; k++) {
    const next = s.indexOf("\n", end + 1);
    end = next === -1 ? s.length : next;
  }
  return s.slice(start, end);
}
