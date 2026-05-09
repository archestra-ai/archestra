import type pino from "pino";
import defaultLogger from "@/logging";
import type {
  Connector,
  ConnectorCredentials,
  ConnectorItemFailure,
  ConnectorItemSkipped,
  ConnectorSyncBatch,
  ConnectorType,
} from "@/types";

/**
 * ACL (Access Control List) interface to hold permission data
 */
export interface ConnectorItemACL {
  allowedUsers: string[]; // List of emails or IDs
  allowedTeams: string[]; // List of team identifiers
  visibilityMode: 'org-wide' | 'team-scoped' | 'auto-sync-permissions';
}

export function buildCheckpoint<
  T extends ConnectorType,
  E extends Record<string, unknown> = Record<never, never>,
>(params: {
  type: T;
  itemUpdatedAt: string | Date | null | undefined;
  previousLastSyncedAt: string | undefined;
  extra?: E;
}): { type: T; lastSyncedAt: string | undefined } & E {
  return {
    type: params.type,
    lastSyncedAt: params.itemUpdatedAt
      ? new Date(String(params.itemUpdatedAt)).toISOString()
      : params.previousLastSyncedAt,
    ...params.extra,
  } as { type: T; lastSyncedAt: string | undefined } & E;
}

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 10000;
const DEFAULT_RATE_LIMIT_DELAY_MS = 100;
export const REQUEST_TIMEOUT_MS = 30000;

export abstract class BaseConnector implements Connector {
  abstract type: ConnectorType;

  protected log: pino.Logger = defaultLogger;
  private rateLimitDelayMs: number;
  private itemFailures: ConnectorItemFailure[] = [];
  private itemSkipped: ConnectorItemSkipped[] = [];

  constructor(rateLimitDelayMs = DEFAULT_RATE_LIMIT_DELAY_MS) {
    this.rateLimitDelayMs = rateLimitDelayMs;
  }

  setLogger(log: pino.Logger): void {
    this.log = log;
  }

  /**
   * POWER LOGIC: Identity Mapper
   * Maps upstream user identities (Jira/Confluence) to Archestra identities
   */
  protected async mapUserIdentity(upstreamId: string, provider: 'jira' | 'confluence'): Promise<string | null> {
    this.log.debug({ upstreamId, provider }, "Mapping user identity for ACL synchronization");
    // Implementation will be handled by inheriting connectors
    return upstreamId; 
  }

  /**
   * POWER LOGIC: Recursive Permission Fetcher
   * To be implemented by Jira/Confluence connectors to extract ACL data
   */
  abstract fetchPermissions(params: {
    itemId: string;
    config: Record<string, unknown>;
    credentials: ConnectorCredentials;
  }): Promise<ConnectorItemACL>;

  protected async validateConfigWithSchema<T>(params: {
    config: Record<string, unknown>;
    parser: (raw: Record<string, unknown>) => T | null;
    label: string;
    invalidConfigError?: string;
    extraChecks?: (parsed: T) => string | null;
  }): Promise<{ valid: boolean; error?: string }> {
    const parsed = params.parser(params.config);
    if (!parsed) {
      return {
        valid: false,
        error:
          params.invalidConfigError ?? `Invalid ${params.label} configuration`,
      };
    }
    const extraError = params.extraChecks?.(parsed);
    if (extraError) {
      return { valid: false, error: extraError };
    }
    return { valid: true };
  }

  protected async runConnectionTest(params: {
    label: string;
    probe: () => Promise<void>;
    errorContext?: (error: unknown) => Record<string, unknown>;
  }): Promise<{ success: boolean; error?: string }> {
    this.log.debug(
      { connectorType: this.type },
      `Testing ${params.label} connection`,
    );
    try {
      await params.probe();
      this.log.debug(
        { connectorType: this.type },
        `${params.label} connection test successful`,
      );
      return { success: true };
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.error(
        {
          connectorType: this.type,
          error: message,
          ...(params.errorContext?.(error) ?? {}),
        },
        `${params.label} connection test failed`,
      );
      return { success: false, error: `Connection failed: ${message}` };
    }
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
    embeddingInputModalities?: import("@shared").ModelInputModality[];
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
            this.log.warn(
              {
                connectorType: this.type,
                attempt: attempt + 1,
                maxRetries,
                status: response.status,
                delayMs: Math.round(delay),
              },
              "Retryable HTTP error, will retry",
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
          this.log.warn(
            {
              connectorType: this.type,
              attempt: attempt + 1,
              maxRetries,
              error: lastError.message,
              delayMs: Math.round(delay),
            },
            "Transient error, will retry",
          );
          await sleep(delay);
          continue;
        }

        throw lastError;
      }
    }

    throw lastError || new Error("Unknown error during fetch retry");
  }

  protected async safeItemFetch<T>(params: {
    fetch: () => Promise<T>;
    fallback: T;
    itemId: string | number;
    resource: string;
  }): Promise<T> {
    try {
      return await params.fetch();
    } catch (error) {
      const message = extractErrorMessage(error);
      this.log.warn(
        {
          connectorType: this.type,
          itemId: params.itemId,
          resource: params.resource,
          error: message,
        },
        "Failed to fetch sub-resource for item, using fallback",
      );
      this.itemFailures.push({
        itemId: params.itemId,
        resource: params.resource,
        error: message,
      });
      return params.fallback;
    }
  }

  protected flushFailures(): ConnectorItemFailure[] {
    const failures = this.itemFailures;
    this.itemFailures = [];
    return failures;
  }

  protected trackSkipped(item: ConnectorItemSkipped): void {
    this.itemSkipped.push(item);
  }

  protected flushSkipped(): ConnectorItemSkipped[] {
    const skipped = this.itemSkipped;
    this.itemSkipped = [];
    return skipped;
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

export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error !== null && typeof error === "object") {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === "string") {
      return obj.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return "[Unknown error object]";
    }
  }
  return String(error);
}
