import { ArchestraInternalErrorCode } from "@archestra/shared";
import {
  getTransientDbErrorCode,
  isDbStatementTimeoutError,
} from "@/database/retry";
import { ApiError, SECRETS_MANAGER_UNAVAILABLE_INTERNAL_CODE } from "@/types";
import {
  collectErrorCodes,
  isConnectionErrno,
  isTimeoutErrno,
} from "@/utils/network-errors";

/**
 * Sink-agnostic policy for what backend errors reach our exception trackers,
 * shared by every capture path (the Sentry `beforeSend` filter and the
 * PostHog request-error / unhandled-rejection capture funnels) so the two
 * sinks agree and the rules live in one place.
 *
 * Two kinds of non-bug failure are handled:
 *
 *   - Expected client/upstream errors (4xx, upstream 502/504, a user's MCP
 *     server that is unreachable or not ready, handled empty-completions) are
 *     dropped — they reflect the request, the caller's config, or an external
 *     dependency, not a crash of ours, and would only create noise.
 *   - Availability incidents (transient DB connectivity, a secrets-backend
 *     outage) are kept but assigned a stable fingerprint so one outage groups
 *     into a single issue instead of fragmenting per in-flight query/route.
 */
interface ErrorTrackingDecision {
  /** When false, the error is expected noise — skip both exception sinks. */
  report: boolean;
  /**
   * Stable grouping key for an availability incident. Applied by each sink in
   * its own shape (Sentry `event.fingerprint`, PostHog `$exception_fingerprint`
   * joined with "/").
   */
  fingerprint?: string[];
  /** Tags/properties describing the grouping, merged into the sink's payload. */
  tags?: Record<string, string>;
}

export function classifyErrorForTracking(
  error: unknown,
): ErrorTrackingDecision {
  // Availability incidents: report once, grouped by root cause.
  //
  // Transient database connectivity failures (DNS lookup, connection refused
  // during a restart, pool connect timeouts) get wrapped per-query by the ORM,
  // which otherwise fragments one incident into an issue per SQL statement.
  const transientDbErrorCode = getTransientDbErrorCode(error);
  if (transientDbErrorCode) {
    return {
      report: true,
      fingerprint: ["db-transient", transientDbErrorCode],
      tags: { error_type: "db_transient", db_error_code: transientDbErrorCode },
    };
  }

  // Statement timeouts (PostgreSQL canceling a query that exceeded
  // statement_timeout) happen under database load or against a slow query
  // plan, and the ORM wraps each one per-query as "Failed query: <sql>" —
  // fragmenting one load incident into an issue per SQL statement. They are
  // deliberately not retried (see isDbStatementTimeoutError), but they should
  // group into a single issue the same way transient connectivity does.
  if (isDbStatementTimeoutError(error)) {
    return {
      report: true,
      fingerprint: ["db-statement-timeout"],
      tags: { error_type: "db_statement_timeout", db_error_code: "57014" },
    };
  }

  // A secrets-backend (e.g. Vault) outage fails every route that reads secrets,
  // fragmenting one incident into an issue per endpoint and upstream message.
  if (
    error instanceof ApiError &&
    error.internalCode === SECRETS_MANAGER_UNAVAILABLE_INTERNAL_CODE
  ) {
    return {
      report: true,
      fingerprint: [SECRETS_MANAGER_UNAVAILABLE_INTERNAL_CODE],
      tags: { error_type: SECRETS_MANAGER_UNAVAILABLE_INTERNAL_CODE },
    };
  }

  // Chat's own MCP gateway being unreachable (pod churn, a missing gateway
  // token) fails every conversation the same way — an availability incident
  // of our deployment, kept but grouped into a single issue. The internal
  // code is set by McpToolsUnavailableError (clients/chat-mcp-client.ts);
  // matched by string so this layer doesn't import the client module.
  if (
    error instanceof ApiError &&
    error.internalCode === "mcp_tools_unavailable"
  ) {
    return {
      report: true,
      fingerprint: ["mcp_tools_unavailable"],
      tags: { error_type: "mcp_tools_unavailable" },
    };
  }

  if (isNonActionableError(error)) {
    return { report: false };
  }

  return { report: true };
}

// === Internal helpers ===

/**
 * Error `name`s for a user's MCP server being unreachable or not yet running —
 * an operational/config condition on the caller's side, not a bug of ours.
 * Matched by name to avoid importing the client error classes into the
 * observability layer.
 */
const MCP_UNREACHABLE_ERROR_NAMES = new Set([
  "McpServerNotReadyError",
  "McpServerConnectionTimeoutError",
  "McpServerUnreachableError",
  "McpServerDeploymentFailedError",
]);

function isNonActionableError(error: unknown): boolean {
  if (error instanceof Error && MCP_UNREACHABLE_ERROR_NAMES.has(error.name)) {
    return true;
  }

  // Low-level connectivity failures that reach the handler unmapped: an
  // undici connect/headers/body timeout or a dropped connection from an
  // outbound fetch, or @fastify/reply-from's upstream-failure errors
  // (502/503/504) from the provider passthrough routes. The other end — an
  // LLM provider, a user-configured server — was unreachable; a network
  // condition, not a bug of ours. Database connectivity never lands here:
  // classifyErrorForTracking classifies it first (kept and grouped).
  if (isUpstreamConnectivityError(error)) {
    return true;
  }

  if (error instanceof ApiError) {
    // 4xx client errors (not found, validation, upstream client errors).
    if (error.statusCode >= 400 && error.statusCode < 500) return true;
    // Relayed upstream provider failures (marked at the LLM proxy's error
    // boundary): the provider's own 5xx, not a crash of ours.
    if (error.upstream) return true;
    // Handled transient upstream conditions.
    if (
      error.internalCode === ArchestraInternalErrorCode.UpstreamEmptyResponse ||
      error.internalCode === ArchestraInternalErrorCode.ProviderOverloaded
    ) {
      return true;
    }
    // Upstream gateway failures and Anthropic overloads.
    if (
      error.statusCode === 502 ||
      error.statusCode === 504 ||
      error.statusCode === 529
    ) {
      return true;
    }
    return false;
  }

  // Generic errors carrying a 4xx HTTP status (Fastify typed errors, or an
  // upstream provider CLIENT error built with an attached statusCode) are
  // expected client errors. Unlike ApiError, a generic 5xx is left to report:
  // a provider's own 5xx (surfaced via the raw-provider-error path) is a
  // diagnostic signal, not one of our upstream-gateway mappings.
  if (
    error &&
    typeof error === "object" &&
    "statusCode" in error &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  ) {
    const statusCode = (error as { statusCode: number }).statusCode;
    if (statusCode >= 400 && statusCode < 500) return true;
  }

  return false;
}

/**
 * Whether the error (or its cause chain) is a low-level connectivity failure
 * to an outbound dependency: a libuv/undici network errno, or one of
 * @fastify/reply-from's upstream-failure errors (`FST_REPLY_FROM_*` with a
 * 502/503/504 status) raised when a passthrough proxy cannot reach its
 * upstream.
 */
function isUpstreamConnectivityError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const codes = collectErrorCodes(error);
  if (codes.some((code) => isConnectionErrno(code) || isTimeoutErrno(code))) {
    return true;
  }

  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return (
    codes.some((code) => code.startsWith("FST_REPLY_FROM_")) &&
    typeof statusCode === "number" &&
    statusCode >= 502 &&
    statusCode <= 504
  );
}
