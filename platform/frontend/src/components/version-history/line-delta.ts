/**
 * Approximate inserted and deleted line counts between two texts, for a
 * diffstat. Lines are compared as a multiset rather than aligned, so a moved
 * line counts as unchanged — cheap enough to run on every section of every
 * version, and close to what `git diff --stat` reports for ordinary edits.
 * Monaco draws the real, aligned diff below it.
 *
 * Unset (`null`) and empty both hold no lines.
 */
export function lineDelta(
  previous: string | null,
  current: string | null,
): { added: number; removed: number } {
  const remaining = new Map<string, number>();
  for (const line of splitLines(previous)) {
    remaining.set(line, (remaining.get(line) ?? 0) + 1);
  }
  let added = 0;
  for (const line of splitLines(current)) {
    const left = remaining.get(line) ?? 0;
    if (left > 0) {
      remaining.set(line, left - 1);
    } else {
      added += 1;
    }
  }
  let removed = 0;
  for (const left of remaining.values()) removed += left;
  return { added, removed };
}

/** How many lines a text holds; unset and empty both hold none. */
export function lineCount(text: string | null): number {
  return splitLines(text).length;
}

function splitLines(text: string | null): string[] {
  return text ? text.split("\n") : [];
}
