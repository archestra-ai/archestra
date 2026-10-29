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

/** The endpoint a failed connection attempt was dialing. */
interface ConnectionFailureTarget {
  host: string;
  /** Set for a failed connect; null for a failed DNS lookup. */
  port: number | null;
}

/**
 * Find the host a low-level connection failure was dialing, from the
 * `address`/`port` (connect) or `hostname` (DNS lookup) fields Node attaches,
 * or from the `connect ECONNREFUSED 10.0.0.1:443` / `getaddrinfo ENOTFOUND
 * example.com` text Node renders when a wrapper only kept the message. Walks
 * causes and AggregateError members; null when no target is named.
 */
export function getConnectionFailureTarget(
  error: unknown,
  maxDepth = 5,
): ConnectionFailureTarget | null {
  if (maxDepth <= 0 || !(error instanceof Error)) return null;

  const fields = error as Error & {
    syscall?: unknown;
    address?: unknown;
    port?: unknown;
    hostname?: unknown;
  };
  if (
    fields.syscall === "connect" &&
    typeof fields.address === "string" &&
    typeof fields.port === "number"
  ) {
    return { host: fields.address, port: fields.port };
  }
  if (fields.syscall === "getaddrinfo" && typeof fields.hostname === "string") {
    return { host: fields.hostname, port: null };
  }

  const rendered = parseRenderedConnectionFailure(error.message);
  if (rendered) return rendered;

  if (error instanceof AggregateError) {
    for (const member of error.errors) {
      const target = getConnectionFailureTarget(member, maxDepth - 1);
      if (target) return target;
    }
  }
  return getConnectionFailureTarget(error.cause, maxDepth - 1);
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

/**
 * Node's rendering of a failed connection syscall. The errno and target follow
 * the syscall name; trailing punctuation from a surrounding sentence is not
 * part of the target.
 */
const RENDERED_CONNECTION_FAILURE_PATTERN =
  /\b(connect|getaddrinfo)\s+E[A-Z_]+\s+([^\s,;'"()]+?)\.?(?=$|[\s,;'"()])/;

function parseRenderedConnectionFailure(
  message: string,
): ConnectionFailureTarget | null {
  const match = RENDERED_CONNECTION_FAILURE_PATTERN.exec(message);
  if (!match) return null;
  const [, syscall, target] = match;
  if (syscall === "getaddrinfo") return { host: target, port: null };

  // connect renders `<address>:<port>`; an IPv6 address keeps its own colons.
  const separator = target.lastIndexOf(":");
  const port = Number(target.slice(separator + 1));
  if (separator <= 0 || !Number.isInteger(port)) return null;
  const host = target.slice(0, separator).replace(/^\[(.*)\]$/, "$1");
  return { host, port };
}
