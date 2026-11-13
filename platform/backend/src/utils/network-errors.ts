import diagnosticsChannel from "node:diagnostics_channel";

/**
 * Shared vocabulary for classifying low-level network failures by their errno
 * code — the codes libuv (Node's `fetch`, sockets) and undici surface when a
 * connection cannot be established, is dropped, or times out before any HTTP
 * response arrives.
 *
 * Consumers ask different questions of these (retryable? connection vs timeout?),
 * so this module owns the vocabulary, a cause-chain code collector, and where a
 * failed connection was going; each caller composes its own domain predicate
 * on top. It deliberately does NOT own
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
 * The first connection or timeout errno in an error's cause chain, e.g.
 * `ETIMEDOUT` or `UND_ERR_CONNECT_TIMEOUT`. Null when the error carries none.
 */
export function getNetworkErrorCode(error: unknown): string | null {
  return (
    collectErrorCodes(error, 5).find(
      (code) => isConnectionErrno(code) || isTimeoutErrno(code),
    ) ?? null
  );
}

/**
 * Remembers the origin of every outbound HTTP request that fails, so a
 * failure that names no endpoint itself (a reset socket, a connect timeout)
 * can still be traced to the host the backend tried to reach.
 *
 * undici, which also backs Node's native `fetch`, publishes each request
 * failure with the request's origin on a diagnostics channel. The error it
 * publishes is the one `fetch` keeps as its `cause` and `undici.request`
 * rejects with, so the origin is found by walking the cause chain.
 */
class OutboundRequestTargets {
  private readonly targets = new WeakMap<object, ConnectionFailureTarget>();
  private installed = false;

  /** Subscribe to undici's request failures. Safe to call more than once. */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    diagnosticsChannel.subscribe(UNDICI_REQUEST_ERROR_CHANNEL, (message) => {
      const { request, error } = message as {
        request?: { origin?: unknown };
        error?: unknown;
      };
      if (typeof error !== "object" || error === null) return;
      const target = parseOrigin(request?.origin);
      if (target) this.targets.set(error, target);
    });
  }

  get(error: object): ConnectionFailureTarget | null {
    return this.targets.get(error) ?? null;
  }
}

export const outboundRequestTargets = new OutboundRequestTargets();

/** The endpoint a failed connection attempt was dialing. */
interface ConnectionFailureTarget {
  host: string;
  /** Set for a failed connect; null for a failed DNS lookup. */
  port: number | null;
}

/**
 * Find the host a low-level connection failure was dialing: the origin of the
 * outbound request that failed (see {@link outboundRequestTargets}), the
 * `address`/`port` (connect) or `hostname` (DNS lookup) fields Node attaches,
 * the `connect ECONNREFUSED 10.0.0.1:443` / `getaddrinfo ENOTFOUND
 * example.com` text Node renders when a wrapper only kept the message, or the
 * `(attempted address: example.com:443, …)` text of undici's connect timeout.
 * Walks causes and AggregateError members; null when no target is named.
 */
export function getConnectionFailureTarget(
  error: unknown,
  maxDepth = 5,
): ConnectionFailureTarget | null {
  if (maxDepth <= 0 || !(error instanceof Error)) return null;

  const requested = outboundRequestTargets.get(error);
  if (requested) return requested;

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

  const rendered =
    parseRenderedConnectionFailure(error.message) ??
    parseAttemptedAddress(error.message);
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

/** Where undici publishes a request that failed, with the request itself. */
const UNDICI_REQUEST_ERROR_CHANNEL = "undici:request:error";

/**
 * undici's connect timeout sets no address fields and renders the endpoint as
 * `Connect Timeout Error (attempted address: example.com:443, timeout: 10000ms)`.
 * An attempt over both address families lists each, comma-separated.
 */
const ATTEMPTED_ADDRESS_PATTERN = /\(attempted addresse?s?: ([^,)\s]+)/;

function parseAttemptedAddress(
  message: string,
): ConnectionFailureTarget | null {
  const target = ATTEMPTED_ADDRESS_PATTERN.exec(message)?.[1];
  return target ? parseHostPort(target) : null;
}

/** The host and port of a request origin such as `https://example.com`. */
function parseOrigin(origin: unknown): ConnectionFailureTarget | null {
  if (typeof origin !== "string") return null;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (!host) return null;
  const port = Number(url.port || DEFAULT_PORTS[url.protocol]);
  return { host, port: Number.isInteger(port) && port > 0 ? port : null };
}

const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  "http:": 80,
  "https:": 443,
};

/** `<host>:<port>`; an IPv6 address keeps its own colons or brackets. */
function parseHostPort(target: string): ConnectionFailureTarget | null {
  const separator = target.lastIndexOf(":");
  const port = Number(target.slice(separator + 1));
  if (separator <= 0 || !Number.isInteger(port)) return null;
  const host = target.slice(0, separator).replace(/^\[(.*)\]$/, "$1");
  return { host, port };
}

function parseRenderedConnectionFailure(
  message: string,
): ConnectionFailureTarget | null {
  const match = RENDERED_CONNECTION_FAILURE_PATTERN.exec(message);
  if (!match) return null;
  const [, syscall, target] = match;
  if (syscall === "getaddrinfo") return { host: target, port: null };
  // connect renders `<address>:<port>`.
  return parseHostPort(target);
}
