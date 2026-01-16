import logger from "@/logging";
import type {
  HealthCheckResult,
  InsertDocumentParams,
  InsertDocumentResult,
  KnowledgeGraphProvider,
  QueryResult,
} from "@/types/knowledge-graph";

/**
 * LightRAG provider configuration
 */
export interface LightRAGConfig {
  /** The LightRAG API server URL (e.g., http://localhost:9621) */
  apiUrl: string;
  /** Optional API key for authentication */
  apiKey?: string;
}

/**
 * LightRAG API response types
 */
interface LightRAGHealthResponse {
  status: string;
  working_directory?: string;
  input_directory?: string;
  configuration?: Record<string, unknown>;
}

interface LightRAGInsertResponse {
  status: string;
  message: string;
  document_count?: number;
  batch_count?: number;
}

interface LightRAGQueryResponse {
  response: string;
}

/** Timeout for health check requests (10 seconds) */
const HEALTH_CHECK_TIMEOUT_MS = 10000;

/** Timeout for document operations (30 seconds) */
const DOCUMENT_OPERATION_TIMEOUT_MS = 30000;

/**
 * Helper to create a fetch request with timeout
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Safely join a base URL with a path
 */
function joinUrl(baseUrl: string, path: string): string {
  // Remove trailing slash from base and leading slash from path
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = path.replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedPath}`;
}

/**
 * LightRAG Knowledge Graph Provider
 *
 * Integrates with a LightRAG server to provide document ingestion
 * and knowledge graph querying capabilities.
 */
export class LightRAGProvider implements KnowledgeGraphProvider {
  readonly providerId = "lightrag" as const;
  readonly displayName = "LightRAG";

  private readonly config: LightRAGConfig;

  constructor(config: LightRAGConfig) {
    this.config = config;
  }

  /**
   * Check if the provider is properly configured
   */
  isConfigured(): boolean {
    return Boolean(this.config.apiUrl);
  }

  /**
   * Initialize the provider
   */
  async initialize(): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error("LightRAG provider is not configured");
    }

    // Verify connectivity
    const health = await this.getHealth();
    if (health.status !== "healthy") {
      throw new Error(
        `LightRAG health check failed: ${health.message || "Unknown error"}`,
      );
    }

    logger.info(
      { apiUrl: this.config.apiUrl },
      "[KnowledgeGraph] LightRAG provider initialized",
    );
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    logger.info("[KnowledgeGraph] LightRAG provider cleaned up");
  }

  /**
   * Insert a document into the knowledge graph
   */
  async insertDocument(
    params: InsertDocumentParams,
  ): Promise<InsertDocumentResult> {
    const { content, filename, metadata } = params;

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (this.config.apiKey) {
        headers["X-API-Key"] = this.config.apiKey;
      }

      const url = joinUrl(this.config.apiUrl, "/documents/text");
      const response = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            text: content,
            // Use filename as document identifier if provided
            // Explicit filename takes precedence over metadata.filename
            ...(filename && { metadata: { ...(metadata ?? {}), filename } }),
          }),
        },
        DOCUMENT_OPERATION_TIMEOUT_MS,
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          {
            status: response.status,
            error: errorText,
            filename,
          },
          "[KnowledgeGraph] Failed to insert document into LightRAG",
        );
        return {
          documentId: "",
          status: "failed",
          error: `LightRAG API error: ${response.status} - ${errorText}`,
        };
      }

      const result = (await response.json()) as LightRAGInsertResponse;

      logger.info(
        {
          filename,
          status: result.status,
          message: result.message,
        },
        "[KnowledgeGraph] Document inserted into LightRAG",
      );

      // LightRAG processes documents asynchronously
      // The document_count > 0 indicates it was accepted for processing
      return {
        documentId: filename || `doc-${Date.now()}`,
        status: result.status === "success" ? "pending" : "failed",
        error: result.status !== "success" ? result.message : undefined,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        { error: errorMessage, filename },
        "[KnowledgeGraph] Error inserting document into LightRAG",
      );
      return {
        documentId: "",
        status: "failed",
        error: errorMessage,
      };
    }
  }

  /**
   * Query the knowledge graph
   */
  async queryDocument(query: string): Promise<QueryResult> {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (this.config.apiKey) {
        headers["X-API-Key"] = this.config.apiKey;
      }

      const url = joinUrl(this.config.apiUrl, "/query");
      const response = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            query,
            mode: "hybrid", // Use hybrid mode for best results
          }),
        },
        DOCUMENT_OPERATION_TIMEOUT_MS,
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          { status: response.status, error: errorText, query },
          "[KnowledgeGraph] Failed to query LightRAG",
        );
        return {
          answer: `Error querying knowledge graph: ${errorText}`,
        };
      }

      const result = (await response.json()) as LightRAGQueryResponse;

      return {
        answer: result.response,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        { error: errorMessage, query },
        "[KnowledgeGraph] Error querying LightRAG",
      );
      return {
        answer: `Error querying knowledge graph: ${errorMessage}`,
      };
    }
  }

  /**
   * Check the health of the LightRAG service
   */
  async getHealth(): Promise<HealthCheckResult> {
    try {
      const headers: Record<string, string> = {};

      if (this.config.apiKey) {
        headers["X-API-Key"] = this.config.apiKey;
      }

      const url = joinUrl(this.config.apiUrl, "/health");
      const response = await fetchWithTimeout(
        url,
        {
          method: "GET",
          headers,
        },
        HEALTH_CHECK_TIMEOUT_MS,
      );

      if (!response.ok) {
        return {
          status: "unhealthy",
          message: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const result = (await response.json()) as LightRAGHealthResponse;

      return {
        status: result.status === "healthy" ? "healthy" : "unhealthy",
        message: result.status === "healthy" ? undefined : result.status,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        status: "unhealthy",
        message: errorMessage,
      };
    }
  }
}
