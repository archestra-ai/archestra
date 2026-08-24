import { KbChunkModel } from "@/models";
import type { VectorSearchResult } from "@/models/kb-chunk";
import type { AclEntry, KbDocumentMetadataFilter } from "@/types";
import type { FindNeighborsParams, NeighborChunk } from "./retrieval-backend";

/**
 * Verify candidates returned by an external retrieval backend against
 * Archestra's canonical PostgreSQL access-control state, and against the
 * document metadata filter the search was scoped to — an external index may
 * not implement the filter, or may hold stale metadata.
 */
export async function verifyExternalRetrievalResults(params: {
  candidates: VectorSearchResult[];
  connectorIds: string[];
  userAcl: AclEntry[];
  bypassAcl?: boolean;
  environmentId?: string | null;
  metadataFilter?: KbDocumentMetadataFilter;
}): Promise<VectorSearchResult[]> {
  return KbChunkModel.verifyExternalSearchResults(params);
}

/**
 * Re-read external neighbour candidates through the canonical PostgreSQL
 * adjacency and access filters. Content returned by the external index is not
 * trusted.
 */
export async function verifyExternalNeighborChunks(
  params: FindNeighborsParams & { candidates: NeighborChunk[] },
): Promise<NeighborChunk[]> {
  if (params.candidates.length === 0) return [];
  const verified = await KbChunkModel.findNeighbors(params);
  const candidateIds = new Set(
    params.candidates.map((candidate) => candidate.id),
  );
  return verified.filter((neighbor) => candidateIds.has(neighbor.id));
}
