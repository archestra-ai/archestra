import logger from "@/logging";
import type {
  Connector,
  ConnectorCredentials,
  ConnectorSyncBatch,
  ConnectorType,
} from "@/types/knowledge-connector";

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 10000;
const DEFAULT_RATE_LIMIT_DELAY_MS = 100;
const REQUEST_TIMEOUT_MS = 30000;

export abstract class BaseConnector implements Connector {
  abstract type: ConnectorType;

  private rateLimitDelayMs: number;

  constructor(rateLimitDelayMs = DEFAULT_RATE_LIMIT_DELAY_MS) {
    this.rateLimitDelayMs = rateLimitDelayMs;
  }

  abstract validateConfig(
    config: Record<string, unknown>,
  ): Promise<{ valid: boolean; error?: string }>;

  abstract testConnection(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<{ success: boolean; error?: string }>;

  async estimateTotalItems(_params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
  }): Promise<number | null> {
    return null;
  }

  abstract sync(params: {
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
    checkpoint: Record<string, unknown> | null;
    startTime?: Date;
    endTime?: Date;
  }): AsyncGenerator<ConnectorSyncBatch>;

  protected buildBasicAuthHeader(email: string, apiToken: string): string {
    const encoded = Buffer.from(`${email}:${apiToken}`).toString("base64");
    return `Basic ${encoded}`;
  }

  protected async fetchWithRetry(
    url: string,
    options: RequestInit,
    maxRetries = MAX_RETRIES,
  ): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          REQUEST_TIMEOUT_MS,
        );

        try {
          const response = await fetch(url, {
            ...options,
            signal: controller.signal,
          });

          if (response.ok || !isRetryableStatus(response.status)) {
            return response;
          }

          if (attempt < maxRetries) {
            const delay = calculateBackoffDelay(attempt);
            logger.warn(
              {
                connectorType: this.type,
                attempt: attempt + 1,
                maxRetries,
                status: response.status,
                delayMs: Math.round(delay),
              },
              "[Connector] Retryable HTTP error, will retry",
            );
            await sleep(delay);
            continue;
          }

          return response;
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (isRetryableError(error) && attempt < maxRetries) {
          const delay = calculateBackoffDelay(attempt);
          logger.warn(
            {
              connectorType: this.type,
              attempt: attempt + 1,
              maxRetries,
              error: lastError.message,
              delayMs: Math.round(delay),
            },
            "[Connector] Transient error, will retry",
          );
          await sleep(delay);
          continue;
        }

        throw lastError;
      }
    }

    throw lastError || new Error("Unknown error during fetch retry");
  }

  protected async rateLimit(): Promise<void> {
    if (this.rateLimitDelayMs > 0) {
      await sleep(this.rateLimitDelayMs);
    }
  }

  protected joinUrl(baseUrl: string, path: string): string {
    const normalizedBase = baseUrl.replace(/\/+$/, "");
    const normalizedPath = path.replace(/^\/+/, "");
    return `${normalizedBase}/${normalizedPath}`;
  }
}

// ===== Internal helpers =====

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
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

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

function calculateBackoffDelay(attempt: number): number {
  const exponentialDelay = RETRY_BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.random() * 0.25 * exponentialDelay;
  return Math.min(exponentialDelay + jitter, RETRY_MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
