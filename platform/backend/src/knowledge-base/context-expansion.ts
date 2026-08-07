import logger from "@/logging";
import { KbChunkModel } from "@/models";
import type { VectorSearchResult } from "@/models/kb-chunk";
import type { AclEntry } from "@/types";

// ===== Exports =====

/**
 * Widen each search hit with the chunks that surround it in its source
 * document.
 *
 * Retrieval ranks chunks, but a chunk boundary is arbitrary: a hit can begin
 * mid-sentence, cut a table in half, or resolve a pronoun whose referent sits in
 * the previous chunk. Expansion changes nothing about ranking or which
 * documents are returned — it only widens the passage the model gets to read
 * around a hit it already earned.
 *
 * Guarantees:
 * - **Contiguity.** A window only ever grows through consecutive chunk indexes.
 *   Walking outward stops at the first index that is missing, whether because it
 *   does not exist or because the user may not read it, so the stitched text is
 *   never two unrelated passages presented as one.
 * - **A hit always keeps its own text.** Neighbours are claimed by the
 *   highest-ranked hit that wants them, so overlapping hits do not repeat the
 *   same surrounding text — but a hit's own chunk is always present, so every
 *   returned citation still has the passage it refers to.
 */
export async function expandChunkContext(params: {
  results: VectorSearchResult[];
  radius: number;
  userAcl: AclEntry[];
  bypassAcl?: boolean;
  environmentId?: string | null;
}): Promise<VectorSearchResult[]> {
  const {
    results,
    radius,
    userAcl,
    bypassAcl = false,
    environmentId,
  } = params;

  if (radius <= 0 || results.length === 0) return results;

  // Media chunks are opaque data URLs with no surrounding prose to stitch.
  const expandable = results.filter((r) => !isMediaChunk(r.content));
  if (expandable.length === 0) return results;

  const neighbors = await KbChunkModel.findNeighbors({
    anchors: expandable.map((r) => ({
      documentId: r.documentId,
      chunkIndex: r.chunkIndex,
    })),
    radius,
    userAcl,
    bypassAcl,
    environmentId,
  });

  if (neighbors.length === 0) return results;

  const byDocument = new Map<string, Map<number, string>>();
  for (const neighbor of neighbors) {
    let doc = byDocument.get(neighbor.documentId);
    if (!doc) {
      doc = new Map();
      byDocument.set(neighbor.documentId, doc);
    }
    doc.set(neighbor.chunkIndex, neighbor.content);
  }

  // Claimed in rank order, so the best hit gets the widest window and a
  // lower-ranked overlapping hit does not repeat text already shown above it.
  const claimed = new Set<string>();
  for (const result of results) {
    claimed.add(chunkKey(result.documentId, result.chunkIndex));
  }

  let expandedCount = 0;
  const expanded = results.map((result) => {
    if (isMediaChunk(result.content)) return result;

    const available = byDocument.get(result.documentId);
    if (!available) return result;

    const window = collectContiguousWindow({
      anchorIndex: result.chunkIndex,
      radius,
      available,
      documentId: result.documentId,
      claimed,
    });

    if (window.length === 0) return result;

    expandedCount++;
    const ordered = [
      ...window.filter((c) => c.chunkIndex < result.chunkIndex),
      { chunkIndex: result.chunkIndex, content: result.content },
      ...window.filter((c) => c.chunkIndex > result.chunkIndex),
    ].sort((a, b) => a.chunkIndex - b.chunkIndex);

    return {
      ...result,
      content: stitch(ordered.map((c) => c.content)),
    };
  });

  logger.debug(
    { radius, resultCount: results.length, expandedCount },
    "[ContextExpansion] Expanded results with neighbouring chunks",
  );

  return expanded;
}

// ===== Internal helpers =====

/**
 * A chunk's stored content carries a `TITLE: ...` prefix so it can be embedded
 * standalone. Repeating it once per stitched chunk would waste context and read
 * as three separate documents, so every chunk after the first in a window has
 * it removed.
 */
const TITLE_PREFIX_PATTERN = /^TITLE: [^\n]*\n\n/;

function isMediaChunk(content: string): boolean {
  return content.startsWith("data:image/");
}

function chunkKey(documentId: string, chunkIndex: number): string {
  return `${documentId}:${chunkIndex}`;
}

/**
 * Walk outward from the anchor in both directions, taking chunks while they are
 * consecutive and unclaimed. Stops at the first gap on each side so the result
 * is always one continuous passage.
 */
function collectContiguousWindow(params: {
  anchorIndex: number;
  radius: number;
  available: Map<number, string>;
  documentId: string;
  claimed: Set<string>;
}): Array<{ chunkIndex: number; content: string }> {
  const { anchorIndex, radius, available, documentId, claimed } = params;
  const window: Array<{ chunkIndex: number; content: string }> = [];

  for (const direction of [-1, 1] as const) {
    for (let step = 1; step <= radius; step++) {
      const index = anchorIndex + direction * step;
      if (index < 0) break;

      const key = chunkKey(documentId, index);
      const content = available.get(index);
      // A missing or already-claimed neighbour ends this side of the window:
      // continuing past it would splice together non-adjacent passages.
      if (content === undefined || claimed.has(key)) break;

      claimed.add(key);
      window.push({ chunkIndex: index, content });
    }
  }

  return window;
}

function stitch(contents: string[]): string {
  return contents
    .map((content, index) =>
      index === 0 ? content : content.replace(TITLE_PREFIX_PATTERN, ""),
    )
    .join("\n\n")
    .trim();
}
