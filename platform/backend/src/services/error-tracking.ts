import { PostHog } from "posthog-node";
import config from "@/config";
import logger from "@/logging";
import {
  logRingBuffer,
  type RetainedLogRecord,
} from "@/logging/log-ring-buffer";
import { OrganizationModel } from "@/models";

/**
 * Backend error tracking via PostHog.
 *
 * Sends unexpected server-side exceptions (5xx request failures, unhandled
 * rejections) to the same PostHog instance the frontend already uses, surfacing
 * them in PostHog's Error Tracking product. Two things make the captured errors
 * cross-referenceable with the rest of the PostHog debugging experience:
 *
 *   - `$session_id` (read from the browser's `X-POSTHOG-SESSION-ID` tracing
 *     header) links the exception back to the originating session replay.
 *   - `preceding_logs` attaches the log lines emitted during the failing
 *     request (scoped by trace id) so the run-up to the error is visible on the
 *     issue without a separate log-ingestion pipeline.
 *
 * Gated entirely by `config.analytics.enabled` — the same switch that governs
 * the frontend PostHog integration and instance heartbeats. Disabled →
 * every method is a cheap no-op.
 */

// Errors are low-volume relative to product events, so flush promptly rather
// than batching — we'd rather pay a request per error than risk losing the tail
// on an abrupt exit.
const FLUSH_AT = 1;
const FLUSH_INTERVAL_MS = 5_000;
const SHUTDOWN_TIMEOUT_MS = 3_000;
const PRECEDING_LOG_LIMIT = 30;

/** Fallback distinct id when an error has no associated user/session. */
const BACKEND_DISTINCT_ID = "archestra-backend";

type PostHogClientLike = {
  captureException(
    error: unknown,
    distinctId?: string,
    additionalProperties?: Record<string, unknown>,
  ): void;
  shutdown(shutdownTimeoutMs?: number): void | Promise<void>;
};

type AnalyticsConfig = (typeof config)["analytics"];

type CaptureExceptionParams = {
  error: unknown;
  /** PostHog distinct id of the user who triggered the error, when known. */
  distinctId?: string | null;
  /** PostHog session id, used to link the error to a session replay. */
  sessionId?: string | null;
  /** Trace id of the failing request, used to scope the preceding log lines. */
  traceId?: string | null;
  /** Extra context merged into the captured event's properties. */
  properties?: Record<string, unknown>;
};

class PostHogErrorTrackingService {
  private client: PostHogClientLike | null = null;
  private instanceId: string | null = null;
  private initialized = false;

  constructor(
    private readonly options: {
      analyticsConfig?: AnalyticsConfig;
      appVersion?: string;
      environment?: string;
      createClient?: (params: {
        key: string;
        host: string;
      }) => PostHogClientLike;
      loadInstanceId?: () => Promise<string | null>;
      getRecentLogs?: (params: {
        traceId?: string;
        limit: number;
      }) => RetainedLogRecord[];
    } = {},
  ) {}

  /**
   * Construct the PostHog client (once) and resolve the analytics instance id.
   * Safe to call unconditionally; no-ops when analytics is disabled or already
   * initialized. A failure to resolve the instance id is non-fatal — errors are
   * still captured, just without instance grouping.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    const analyticsConfig = this.getAnalyticsConfig();
    if (!analyticsConfig.enabled || !analyticsConfig.posthog.key) return;

    this.client = this.createClient({
      key: analyticsConfig.posthog.key,
      host: analyticsConfig.posthog.host,
    });

    try {
      this.instanceId = await this.loadInstanceId();
    } catch (error) {
      logger.warn(
        { err: error },
        "Failed to resolve analytics instance id for error tracking",
      );
    }
  }

  /**
   * Enqueue an exception for delivery to PostHog Error Tracking. Non-blocking
   * and never throws — a failure to capture must not mask the original error.
   */
  captureException({
    error,
    distinctId,
    sessionId,
    traceId,
    properties,
  }: CaptureExceptionParams): void {
    if (!this.client) return;

    try {
      const resolvedDistinctId =
        distinctId || this.instanceId || BACKEND_DISTINCT_ID;
      const isAnonymousInstanceError = !distinctId;

      const precedingLogs = this.getRecentLogs({
        traceId: traceId ?? undefined,
        limit: PRECEDING_LOG_LIMIT,
      });

      this.client.captureException(error, resolvedDistinctId, {
        source: "backend",
        app_version: this.getAppVersion(),
        environment: this.getEnvironment(),
        ...(this.instanceId && {
          instance_id: this.instanceId,
          $groups: { instance: this.instanceId },
        }),
        // Don't spin up a PostHog person profile for the synthetic instance id;
        // real user errors (distinctId present) keep default person processing.
        ...(isAnonymousInstanceError && { $process_person_profile: false }),
        ...(sessionId && { $session_id: sessionId }),
        ...(precedingLogs.length > 0 && {
          preceding_logs: precedingLogs.map(formatLogRecord),
        }),
        ...properties,
      });
    } catch (captureError) {
      logger.warn(
        { err: captureError },
        "Failed to capture exception to PostHog",
      );
    }
  }

  /** Flush pending events and tear down the client on shutdown. */
  async shutdown(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.shutdown(SHUTDOWN_TIMEOUT_MS);
    } catch (error) {
      logger.warn({ err: error }, "Failed to shut down PostHog error tracking");
    } finally {
      this.client = null;
    }
  }

  // === Internal helpers ===

  private getAnalyticsConfig(): AnalyticsConfig {
    return this.options.analyticsConfig ?? config.analytics;
  }

  private getAppVersion(): string {
    return this.options.appVersion ?? config.api.version;
  }

  private getEnvironment(): string {
    return this.options.environment ?? (config.environment || "development");
  }

  private createClient(params: {
    key: string;
    host: string;
  }): PostHogClientLike {
    if (this.options.createClient) return this.options.createClient(params);
    return new PostHog(params.key, {
      host: params.host,
      flushAt: FLUSH_AT,
      flushInterval: FLUSH_INTERVAL_MS,
    });
  }

  private async loadInstanceId(): Promise<string | null> {
    if (this.options.loadInstanceId) return this.options.loadInstanceId();
    return (await OrganizationModel.getAnalyticsState()).analyticsInstanceId;
  }

  private getRecentLogs(params: {
    traceId?: string;
    limit: number;
  }): RetainedLogRecord[] {
    if (this.options.getRecentLogs) return this.options.getRecentLogs(params);
    return logRingBuffer.getRecent(params);
  }
}

export const posthogErrorTrackingService = new PostHogErrorTrackingService();

/** @public — exported for testability */
export { PostHogErrorTrackingService };

function formatLogRecord(record: RetainedLogRecord): {
  time: string;
  level: string;
  msg: string;
} {
  return {
    time: new Date(record.time).toISOString(),
    level: record.levelLabel,
    msg: record.msg,
  };
}
