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
 * Gather candidate errno strings from an error and its `cause` chain — Node's
 * `fetch` wraps the real libuv error as `cause`, sometimes a level or two deep.
 * Bounded by `maxDepth` to guard against circular `cause` references.
 */
export function collectErrorCodes(error: unknown, maxDepth = 3): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < maxDepth && current instanceof Error; depth++) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    current = (current as Error & { cause?: unknown }).cause;
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
