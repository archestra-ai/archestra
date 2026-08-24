import type { TextSearchLanguage } from "@archestra/shared";
import type { Bm25Tuning, VectorSearchResult } from "@/models/kb-chunk";
import type {
  AclEntry,
  InsertKbChunk,
  KbChunk,
  KbDocumentMetadataFilter,
} from "@/types";

// ===== Public contract =====

/**
 * Storage and search operations required by the knowledge retrieval pipeline.
 *
 * Implementations own chunk indexing, vector and keyword search, adjacency,
 * parent-passage reassembly, and deletion. Every read method receives the caller's ACL and environment
 * scope. An implementation must apply both before returning any content.
 * Search results must retain document and chunk identity because citations and
 * context expansion depend on those fields after ranking.
 *
 * A search scope may also carry a document metadata filter. Unlike the ACL and
 * environment predicates it is not a security control — it only ever removes
 * documents — but an implementation that ignores it silently returns results
 * from outside the set the caller asked for, so it must be honored (or the
 * backend must set `requiresResultVerification`, which re-applies it in
 * PostgreSQL).
 *
 * PostgreSQL is the only implementation shipped by Archestra. Keeping callers
 * behind this contract lets another implementation be added at construction
 * time without changing ingestion, query, or context-expansion code.
 */
export interface KnowledgeRetrievalBackend {
  /**
   * External indexes set this to true. Their candidates are then re-hydrated
   * from PostgreSQL and checked against Archestra's ACL and environment scope.
   * The built-in PostgreSQL queries already apply those predicates directly.
   */
  requiresResultVerification: boolean;
  insertChunks(chunks: InsertKbChunk[]): Promise<KbChunk[]>;
  getDocumentChunks(documentId: string): Promise<KbChunk[]>;
  countDocumentChunks(documentId: string): Promise<number>;
  deleteDocumentChunks(documentId: string): Promise<number>;
  indexEmbeddings(params: {
    updates: Array<{ chunkId: string; embedding: number[] }>;
    dimensions: number;
  }): Promise<void>;
  vectorSearch(params: VectorSearchParams): Promise<VectorSearchResult[]>;
  keywordSearch(params: KeywordSearchParams): Promise<VectorSearchResult[]>;
  findNeighbors(params: FindNeighborsParams): Promise<NeighborChunk[]>;
  findParentSiblings(
    params: FindParentSiblingsParams,
  ): Promise<ParentSiblingChunk[]>;
  getTextSearchLanguages(connectorIds: string[]): Promise<TextSearchLanguage[]>;
  getPopulatedEmbeddingDimensions(connectorIds: string[]): Promise<Set<number>>;
  hasKeywordStatistics(
    languages: TextSearchLanguage[],
    connectorIds: string[],
  ): Promise<boolean>;
  isSearchTimeout(error: unknown): boolean;
}

export interface VectorSearchParams extends SearchScope {
  queryEmbedding: number[];
  dimensions: number;
  limit?: number;
}

export interface KeywordSearchParams extends SearchScope {
  queryText: string;
  languages?: TextSearchLanguage[];
  bm25?: Bm25Tuning;
  limit?: number;
}

export interface FindNeighborsParams extends AccessScope {
  anchors: Array<{ documentId: string; chunkIndex: number }>;
  radius: number;
}

export interface NeighborChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
}

export interface FindParentSiblingsParams extends AccessScope {
  parents: Array<{ documentId: string; parentIndex: number }>;
}

export interface ParentSiblingChunk extends NeighborChunk {
  parentIndex: number;
}

// ===== Internal types =====

interface AccessScope {
  userAcl: AclEntry[];
  bypassAcl?: boolean;
  environmentId?: string | null;
}

interface SearchScope extends AccessScope {
  connectorIds: string[];
  /**
   * Narrows the search to documents whose `metadata` satisfies this predicate.
   * Deliberately on the search scope rather than {@link AccessScope}: a set
   * decides what is *searched*, access decides what may be *read*. An
   * implementation must treat it as an additional AND, never as a substitute
   * for the ACL predicate — narrowing a search must never be able to widen it.
   */
  metadataFilter?: KbDocumentMetadataFilter;
}
