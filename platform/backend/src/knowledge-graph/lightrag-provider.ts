import logger from "@/logging";
import type {
  HealthCheckResult,
  InsertDocumentParams,
  InsertDocumentResult,
  KnowledgeGraphProvider,
  QueryOptions,
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

/** Maximum number of retry attempts for transient failures */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff (milliseconds) */
const RETRY_BASE_DELAY_MS = 1000;

/** Maximum delay between retries (milliseconds) */
const RETRY_MAX_DELAY_MS = 10000;

/**
 * Check if an error is retryable (transient failure)
 */
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    // Retry on network errors, timeouts, and connection issues
    return (
      message.includes("fetch") ||
      message.includes("network") ||
      message.includes("timeout") ||
      message.includes("aborted") ||
      message.includes("econnrefused") ||
      message.includes("econnreset") ||
      message.includes("etimedout") ||
      message.includes("socket")
    );
  }
  return false;
}

/**
 * Check if an HTTP status code is retryable
 */
function isRetryableStatus(status: number): boolean {
  // Retry on 5xx server errors and 429 (rate limiting)
  return status >= 500 || status === 429;
}

/**
 * Calculate delay for exponential backoff with jitter
 */
function calculateBackoffDelay(attempt: number): number {
  // Exponential backoff: baseDelay * 2^attempt
  const exponentialDelay = RETRY_BASE_DELAY_MS * 2 ** attempt;
  // Add random jitter (0-25% of delay) to prevent thundering herd
  const jitter = Math.random() * 0.25 * exponentialDelay;
  // Cap at max delay
  return Math.min(exponentialDelay + jitter, RETRY_MAX_DELAY_MS);
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
 * Fetch with timeout and retry logic for transient failures
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  context: string,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);

      // If response is OK or a non-retryable error, return it
      if (response.ok || !isRetryableStatus(response.status)) {
        return response;
      }

      // For retryable HTTP errors, clone the response for potential retry
      if (attempt < MAX_RETRIES) {
        const delay = calculateBackoffDelay(attempt);
        logger.warn(
          {
            context,
            attempt: attempt + 1,
            maxRetries: MAX_RETRIES,
            status: response.status,
            delayMs: Math.round(delay),
          },
          "[KnowledgeGraph] Retryable HTTP error, will retry",
        );
        await sleep(delay);
        continue;
      }

      // Last attempt, return the error response
      return response;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if error is retryable
      if (isRetryableError(error) && attempt < MAX_RETRIES) {
        const delay = calculateBackoffDelay(attempt);
        logger.warn(
          {
            context,
            attempt: attempt + 1,
            maxRetries: MAX_RETRIES,
            error: lastError.message,
            delayMs: Math.round(delay),
          },
          "[KnowledgeGraph] Transient error, will retry",
        );
        await sleep(delay);
        continue;
      }

      // Non-retryable error or max retries reached
      throw lastError;
    }
  }

  // Should not reach here, but throw last error if we do
  throw lastError || new Error("Unknown error during fetch retry");
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

      // Build metadata object - include filename if provided, preserve other metadata
      const metadataObj = {
        ...(metadata ?? {}),
        ...(filename && { filename }),
      };

      const response = await fetchWithRetry(
        url,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            text: content,
            // Include metadata if we have any fields
            ...(Object.keys(metadataObj).length > 0 && {
              metadata: metadataObj,
            }),
          }),
        },
        DOCUMENT_OPERATION_TIMEOUT_MS,
        "insertDocument",
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
   * @param query - Natural language query
   * @param options - Query options
   */
  async queryDocument(
    query: string,
    options?: QueryOptions,
  ): Promise<QueryResult> {
    const mode = options?.mode ?? "hybrid";

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (this.config.apiKey) {
        headers["X-API-Key"] = this.config.apiKey;
      }

      const url = joinUrl(this.config.apiUrl, "/query");
      const response = await fetchWithRetry(
        url,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            query,
            mode,
          }),
        },
        DOCUMENT_OPERATION_TIMEOUT_MS,
        "queryDocument",
      );

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(
          { status: response.status, error: errorText, query },
          "[KnowledgeGraph] Failed to query LightRAG",
        );
        return {
          answer: "",
          error: `LightRAG API error: ${response.status} - ${errorText}`,
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
        answer: "",
        error: errorMessage,
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
      const response = await fetchWithRetry(
        url,
        {
          method: "GET",
          headers,
        },
        HEALTH_CHECK_TIMEOUT_MS,
        "healthCheck",
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
