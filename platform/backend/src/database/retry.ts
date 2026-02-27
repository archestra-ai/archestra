/**
 * Automatic retry logic for transient database connection errors.
 *
 * Drizzle ORM has no middleware/plugin system for query retry, and pg/pg-pool
 * have no built-in retry support, so we implement it here at the pool level.
 *
 * @see https://github.com/brianc/node-postgres/issues/434
 * @see https://neon.com/guides/building-resilient-applications-with-postgres
 */
import logger from "@/logging";

/**
 * Maximum number of retry attempts for transient database errors.
 * Total attempts = MAX_RETRIES + 1 (initial attempt + retries).
 */
const MAX_RETRIES = 3;

/** Base delay in milliseconds for exponential backoff */
const BASE_DELAY_MS = 100;

/** Maximum delay in milliseconds between retries */
const MAX_DELAY_MS = 2000;

/**
 * PostgreSQL error codes that indicate transient connection issues.
 * These are SQLSTATE codes from the Connection Exception class (08xxx)
 * and Operator Intervention class (57Pxx).
 *
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
const TRANSIENT_PG_CODES = new Set([
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08006", // connection_failure
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

/**
 * Error message substrings that indicate transient connection issues.
 * These cover errors from node-postgres (pg) and the TCP/socket layer.
 */
const TRANSIENT_ERROR_PATTERNS = [
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "Connection terminated",
  "timeout expired",
];

/** Maximum depth for cause-chain traversal to guard against circular references */
const MAX_CAUSE_DEPTH = 5;

/**
 * Determine whether a database error is transient (i.e. retrying may succeed).
 *
 * Checks the error itself and, for DrizzleQueryError wrappers, recursively
 * checks the underlying cause (bounded to {@link MAX_CAUSE_DEPTH} levels).
 */
export function isTransientDbError(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error)) return false;
  if (depth > MAX_CAUSE_DEPTH) return false;

  // Check PostgreSQL error code (set by node-postgres on query errors)
  const pgCode = (error as Error & { code?: string }).code;
  if (pgCode && TRANSIENT_PG_CODES.has(pgCode)) return true;

  // Check error message for known transient patterns
  const message = error.message;
  if (TRANSIENT_ERROR_PATTERNS.some((pattern) => message.includes(pattern))) {
    return true;
  }

  // DrizzleQueryError wraps the underlying pg error as `cause`
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause) return isTransientDbError(cause, depth + 1);

  return false;
}

/**
 * Calculate exponential backoff delay with jitter.
 *
 * Formula: min(BASE_DELAY * 2^attempt + jitter, MAX_DELAY)
 * Jitter is 0–25% of the exponential delay to prevent thundering herd.
 */
function calculateBackoff(attempt: number): number {
  const exponentialDelay = BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.random() * 0.25 * exponentialDelay;
  return Math.min(exponentialDelay + jitter, MAX_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an async function with automatic retry on transient database errors.
 *
 * Uses exponential backoff with jitter between retries.
 * Only retries errors identified as transient by {@link isTransientDbError}.
 *
 * @example
 * ```ts
 * const users = await withDbRetry(() =>
 *   db.select().from(usersTable).where(eq(usersTable.id, userId))
 * );
 * ```
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  options?: { maxRetries?: number },
): Promise<T> {
  const maxRetries = options?.maxRetries ?? MAX_RETRIES;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (isTransientDbError(error) && attempt < maxRetries) {
        const delay = calculateBackoff(attempt);
        logger.warn(
          {
            err: error,
            attempt: attempt + 1,
            maxRetries,
            retryInMs: Math.round(delay),
          },
          "Transient database error, retrying query",
        );
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }

  // Unreachable — the loop always returns or throws — but TypeScript needs it
  throw new Error("withDbRetry: unreachable");
}

/** Symbol marker to prevent double-wrapping the same pool */
const RETRY_WRAPPED = Symbol("retryWrapped");

/**
 * Wrap a pg.Pool instance so that its `query()` method automatically retries
 * transient connection errors.
 *
 * This is safe for non-transaction queries because `pool.query()` internally
 * checks out a client, runs the query, and releases it — each retry gets a
 * fresh connection from the pool.
 *
 * Transaction queries (via a checked-out PoolClient) are NOT affected by this
 * wrapper; callers should use {@link withDbRetry} around the entire transaction.
 *
 * Calling this function multiple times on the same pool is a no-op (guarded
 * by a Symbol marker to prevent compounding retries).
 */
export function wrapPoolWithRetry(pool: {
  query: (...args: unknown[]) => unknown;
}): void {
  if ((pool as Record<symbol, unknown>)[RETRY_WRAPPED]) return;

  const originalQuery = pool.query.bind(pool);

  pool.query = ((...args: unknown[]) => {
    // If the last argument is a callback, pass through without retry
    // (callback-style calls are not used by Drizzle)
    if (typeof args[args.length - 1] === "function") {
      return originalQuery(...args);
    }

    // Promise-style call: wrap with retry logic
    return withDbRetry(() => originalQuery(...args) as Promise<unknown>);
  }) as typeof pool.query;

  (pool as Record<symbol, unknown>)[RETRY_WRAPPED] = true;
}
