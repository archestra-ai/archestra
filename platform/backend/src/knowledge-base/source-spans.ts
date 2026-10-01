import type { KnowledgeSourceSpan } from "@/types";

/** Merge source ranges in document order, coalescing overlaps and adjacency. */
export function mergeSourceSpans(
  spans: Array<KnowledgeSourceSpan[] | null | undefined>,
): KnowledgeSourceSpan[] | null {
  const ordered = spans
    .flatMap((span) => span ?? [])
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (ordered.length === 0) return null;

  const merged: KnowledgeSourceSpan[] = [{ ...ordered[0] }];
  for (const span of ordered.slice(1)) {
    const previous = merged[merged.length - 1];
    if (span.start <= previous.end) {
      previous.end = Math.max(previous.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}
