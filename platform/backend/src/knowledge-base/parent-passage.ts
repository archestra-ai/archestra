import logger from "@/logging";
import type { VectorSearchResult } from "@/models/kb-chunk";
import type { AclEntry } from "@/types";
import type { KnowledgeRetrievalBackend } from "./retrieval-backend";
import { knowledgeRetrievalBackend } from "./retrieval-backends/registry";

// ===== Exports =====

/**
 * Parent/child retrieval: match on small chunks, return the passage they came
 * from.
 *
 * Indexing a corpus at one size forces one compromise on every query. A chunk
 * small enough that a port number dominates its embedding is too small to
 * explain what the port belongs to; a chunk large enough to carry that
 * explanation has diluted the port number past the point of matching it. So the
 * ingest pass cuts twice — passages, then children within each passage — and
 * indexes only the children. Matching happens at the size that makes a specific
 * fact findable, and reading happens at the size that makes it make sense.
 *
 * This module is the "on the way out" half: collapse sibling hits down to one
 * result per passage, then reassemble each passage from its children.
 *
 * ## Relationship to context expansion
 *
 * The two do the same job — widen what the model reads around a hit — by
 * different means, and a hit gets exactly one of them, never both. Stacking
 * them would return a passage plus a radius of passages around it, which is the
 * large-and-diluted result the split exists to avoid.
 *
 * Which one applies is a property of the chunk, not a setting: a chunk with a
 * `parentIndex` is a child and resolves to its passage; a chunk without one is
 * already a passage and context expansion widens it as before. That is what
 * lets a corpus indexed before parent/child existed keep working untouched
 * alongside one indexed after it — including, on a mixed deployment, within a
 * single result set.
 */
export async function resolveParentPassages(params: {
  results: VectorSearchResult[];
  userAcl: AclEntry[];
  bypassAcl?: boolean;
  environmentId?: string | null;
  retrievalBackend?: KnowledgeRetrievalBackend;
}): Promise<VectorSearchResult[]> {
  const {
    results,
    userAcl,
    bypassAcl = false,
    environmentId,
    retrievalBackend = knowledgeRetrievalBackend,
  } = params;

  const parents = results
    .filter((result) => result.parentIndex !== null)
    .map((result) => ({
      documentId: result.documentId,
      parentIndex: result.parentIndex as number,
    }));
  if (parents.length === 0) return results;

  const siblings = await retrievalBackend.findParentSiblings({
    parents,
    userAcl,
    bypassAcl,
    environmentId,
  });
  if (siblings.length === 0) return results;

  const byParent = new Map<
    string,
    Array<{ chunkIndex: number; content: string }>
  >();
  for (const sibling of siblings) {
    const key = parentKey(sibling.documentId, sibling.parentIndex);
    const group = byParent.get(key) ?? [];
    group.push({ chunkIndex: sibling.chunkIndex, content: sibling.content });
    byParent.set(key, group);
  }

  let resolvedCount = 0;
  const resolved = results.map((result) => {
    if (result.parentIndex === null) return result;

    const group = byParent.get(
      parentKey(result.documentId, result.parentIndex),
    );
    if (!group || group.length === 0) return result;

    resolvedCount++;
    const ordered = [...group].sort((a, b) => a.chunkIndex - b.chunkIndex);
    return {
      ...result,
      content: stitchChunkContents(ordered.map((c) => c.content)),
    };
  });

  logger.debug(
    {
      resultCount: results.length,
      parentCount: byParent.size,
      resolvedCount,
    },
    "[ParentPassage] Resolved child hits to their parent passages",
  );

  return resolved;
}

/**
 * Drop hits that are siblings of a better-ranked hit.
 *
 * Small chunks make near-duplicate hits likely: a query that matches one
 * sentence of a passage tends to match the sentence beside it, and each of
 * those children would otherwise resolve to the SAME passage and return it
 * again. So only the best-ranked child of each passage survives, and the rest
 * of the result set is spent on other passages.
 *
 * Deliberately runs on the whole fused list, before any truncation. Collapsing
 * after a slice would quietly return fewer results than asked for whenever
 * siblings placed in the top ranks — the classic parent/child trap, where the
 * requested result count is spent on children and collapses to a handful of
 * documents. Collapsing first means every slot downstream, in the rerank window
 * and in the final result set alike, holds a distinct passage.
 *
 * Rank order is preserved, and chunks with no parent are never touched — they
 * are their own passage, and two of them are two distinct results.
 */
export function collapseParentSiblings(
  results: VectorSearchResult[],
): VectorSearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (result.parentIndex === null) return true;
    const key = parentKey(result.documentId, result.parentIndex);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Join chunk texts into one passage.
 *
 * A chunk's stored content carries a `TITLE: ...` prefix so it can be embedded
 * standalone. Repeating it once per chunk would waste context and read as
 * several separate documents, so every chunk after the first has it removed.
 *
 * Each piece is trimmed before joining, so the seams are exactly one blank line
 * wherever a chunk boundary fell. Without that, a boundary landing on a
 * paragraph break — which is precisely where the recursive splitter prefers to
 * cut — would join the break already inside the text to the one added here and
 * open a widening run of blank lines at every seam. Reassembling a passage from
 * its children then reproduces the text the un-split chunk held, rather than a
 * ragged copy of it.
 *
 * Shared with context expansion so a stitched passage looks the same however it
 * was assembled.
 */
export function stitchChunkContents(contents: string[]): string {
  return contents
    .map((content, index) =>
      index === 0 ? content : content.replace(TITLE_PREFIX_PATTERN, ""),
    )
    .map((content) => content.trim())
    .filter((content) => content.length > 0)
    .join("\n\n");
}

// ===== Internal helpers =====

const TITLE_PREFIX_PATTERN = /^TITLE: [^\n]*\n\n/;

function parentKey(documentId: string, parentIndex: number): string {
  return `${documentId}:${parentIndex}`;
}
