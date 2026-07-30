import { diff3Merge } from "node-diff3";

/**
 * Rebase an edit built on a stale base version onto the current head, git
 * style: the proposed document is interpreted as a delta from the base the
 * caller declared, and that delta is three-way merged with what the head
 * changed since. This is what makes edit_app's version counter enforce
 * incorporation, not just freshness — changes another conversation published
 * land in the result mechanically when regions are disjoint, and overlapping
 * regions surface as conflicts carrying the head's actual content instead of
 * a bare "re-read and retry" (which steers a model into resubmitting the same
 * document over a fresher version).
 */
export function mergeStaleBaseDocument(params: {
  baseHtml: string;
  headHtml: string;
  proposedHtml: string;
}):
  | { ok: true; html: string }
  | { ok: false; conflicts: { headContent: string; proposedContent: string }[] } {
  const base = params.baseHtml.split("\n");
  const head = params.headHtml.split("\n");
  const proposed = params.proposedHtml.split("\n");

  const regions = diff3Merge(proposed, base, head, { excludeFalseConflicts: true });
  const merged: string[] = [];
  const conflicts: { headContent: string; proposedContent: string }[] = [];
  for (const region of regions) {
    if (region.ok) {
      merged.push(...region.ok);
    } else if (region.conflict) {
      conflicts.push({
        headContent: region.conflict.b.join("\n"),
        proposedContent: region.conflict.a.join("\n"),
      });
    }
  }
  if (conflicts.length > 0) return { ok: false, conflicts };
  return { ok: true, html: merged.join("\n") };
}
