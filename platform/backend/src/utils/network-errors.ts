/**
 * Shared vocabulary for classifying low-level network failures by their errno
 * code — the codes libuv (Node's `fetch`, sockets) and undici surface when a
 * connection cannot be established, is dropped, or times out before any HTTP
 * response arrives.
 *
 * Consumers ask different questions of these (retryable? connection vs timeout?),
 * so this module owns only the vocabulary and a cause-chain code collector; each
 * caller composes its own domain predicate on top. It deliberately does NOT own
 * database transience — Postgres SQLSTATE codes and pool-specific message
 * patterns live in `database/retry.ts`, a different concern with different codes.
 */

/** Whether a code names a connection failure (dropped / refused / unreachable). */
export function isConnectionErrno(code: string | null | undefined): boolean {
  return typeof code === "string" && CONNECTION_ERRNOS.has(code);
}

/** Whether a code names a connection that specifically *timed out*. */
export function isTimeoutErrno(code: string | null | undefined): boolean {
  return typeof code === "string" && TIMEOUT_ERRNOS.has(code);
}

/**
 * Native fetch identifies HTTP transport failures with a TypeError wrapper.
 * Require both that wrapper and a network code: malformed URLs and other
 * programming errors also throw TypeError and must remain visible.
 */
export function isFetchConnectivityError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.message === "fetch failed" &&
    collectErrorCodes(error).some(
      (code) => isConnectionErrno(code) || isTimeoutErrno(code),
    )
  );
}

/**
 * Gather errno strings from causes and AggregateError members. Node's fetch
 * can wrap separate IPv4/IPv6 connection failures in an aggregate cause.
 * Bounded by `maxDepth` to guard against circular references.
 */
export function collectErrorCodes(error: unknown, maxDepth = 3): string[] {
  if (maxDepth <= 0 || !(error instanceof Error)) return [];

  const codes: string[] = [];
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === "string") codes.push(code);
  codes.push(...collectErrorCodes(error.cause, maxDepth - 1));
  if (error instanceof AggregateError) {
    for (const member of error.errors) {
      codes.push(...collectErrorCodes(member, maxDepth - 1));
    }
  }
  return codes;
}

// === Internal vocabulary ===

/** Errno codes for a connection that failed or was dropped (not a timeout). */
const CONNECTION_ERRNOS: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN", // transient DNS resolution failure
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "EPIPE",
  "UND_ERR_SOCKET",
]);

/** Errno codes for a connection that specifically *timed out*. */
const TIMEOUT_ERRNOS: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
