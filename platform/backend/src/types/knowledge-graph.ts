import { z } from "zod";

/**
 * Supported knowledge graph provider types
 */
export const KnowledgeGraphProviderTypeSchema = z.enum(["lightrag"]);
export type KnowledgeGraphProviderType = z.infer<
  typeof KnowledgeGraphProviderTypeSchema
>;

/**
 * Result of inserting a document into the knowledge graph
 */
export interface InsertDocumentResult {
  /** Unique identifier for the ingested document */
  documentId: string;
  /** Processing status - documents may be processed asynchronously */
  status: "pending" | "processed" | "failed";
  /** Optional error message if status is "failed" */
  error?: string;
}

/**
 * Query modes supported by LightRAG
 * - local: Uses only local context from the knowledge graph
 * - global: Uses global context across all documents
 * - hybrid: Combines local and global context (recommended)
 * - naive: Simple RAG without graph-based retrieval
 */
export const QueryModeSchema = z.enum(["local", "global", "hybrid", "naive"]);
export type QueryMode = z.infer<typeof QueryModeSchema>;

/**
 * Options for querying the knowledge graph
 */
export interface QueryOptions {
  /** Query mode (local, global, hybrid, naive). Defaults to hybrid. */
  mode?: QueryMode;
}

/**
 * Result of querying the knowledge graph
 */
export interface QueryResult {
  /** The answer generated from the knowledge graph */
  answer: string;
  /** Source documents/chunks that contributed to the answer */
  sources?: Array<{
    documentId: string;
    content?: string;
  }>;
  /** Error message if the query failed */
  error?: string;
}

/**
 * Health check result
 */
export interface HealthCheckResult {
  status: "healthy" | "unhealthy";
  message?: string;
}

/**
 * Parameters for inserting a document
 */
export interface InsertDocumentParams {
  /** The document content (text, markdown, etc.) */
  content: string;
  /** Optional filename for reference */
  filename?: string;
  /** Optional metadata to associate with the document */
  metadata?: Record<string, unknown>;
}

/**
 * Interface for knowledge graph providers (LightRAG, etc.)
 *
 * Implementations should:
 * 1. Connect to the underlying knowledge graph service
 * 2. Handle document ingestion
 * 3. Support querying the knowledge base
 * 4. Provide health checks
 */
export interface KnowledgeGraphProvider {
  /** Provider identifier (e.g., 'lightrag') */
  readonly providerId: KnowledgeGraphProviderType;

  /** Display name for the UI */
  readonly displayName: string;

  /**
   * Check if the provider is properly configured
   */
  isConfigured(): boolean;

  /**
   * Initialize the provider (setup connections, etc.)
   * Called once when the server starts if the provider is configured
   */
  initialize(): Promise<void>;

  /**
   * Clean up resources (close connections, etc.)
   * Called on graceful shutdown
   */
  cleanup(): Promise<void>;

  /**
   * Insert a document into the knowledge graph
   * @param params - Document content and metadata
   * @returns The document ID and processing status
   */
  insertDocument(params: InsertDocumentParams): Promise<InsertDocumentResult>;

  /**
   * Query the knowledge graph
   * @param query - Natural language query
   * @param options - Query options
   * @returns The answer and optional source references
   */
  queryDocument(query: string, options?: QueryOptions): Promise<QueryResult>;

  /**
   * Check the health of the knowledge graph service
   */
  getHealth(): Promise<HealthCheckResult>;
}

/**
 * Knowledge graph provider configuration from environment variables
 */
export interface KnowledgeGraphConfig {
  /** The provider type to use (undefined = feature disabled) */
  provider: KnowledgeGraphProviderType | undefined;
  /** LightRAG-specific configuration */
  lightrag?: {
    /** The LightRAG API server URL (e.g., http://localhost:9621) */
    apiUrl: string;
    /** Optional API key for authentication */
    apiKey?: string;
  };
}
