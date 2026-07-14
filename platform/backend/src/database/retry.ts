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
 * The effective limit is usually {@link RETRY_BUDGET_MS}: retries stop as
 * soon as the next backoff would overrun the time budget.
 */
const MAX_RETRIES = 8;

/**
 * Wall-clock budget for a single retried operation. Sized to ride out a
 * short database restart or failover instead of giving up within the first
 * second, while still bounding how long a request can hang on the pool.
 */
const RETRY_BUDGET_MS = 15_000;

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
 * Error message substrings that indicate transient connection issues, each
 * paired with a stable code used to group occurrences in error tracking.
 * These cover errors from node-postgres (pg), DNS resolution, and the
 * TCP/socket layer.
 */
const TRANSIENT_ERROR_PATTERNS: ReadonlyArray<{
  pattern: string;
  code: string;
}> = [
  { pattern: "ECONNREFUSED", code: "ECONNREFUSED" },
  { pattern: "ECONNRESET", code: "ECONNRESET" },
  { pattern: "EPIPE", code: "EPIPE" },
  { pattern: "ETIMEDOUT", code: "ETIMEDOUT" },
  // DNS resolution failures (getaddrinfo). EAI_AGAIN is an explicitly
  // temporary lookup failure; ENOTFOUND is a name that did not resolve,
  // which is transient when a database host briefly stops resolving during
  // a restart or failover (common with in-cluster service DNS).
  { pattern: "EAI_AGAIN", code: "EAI_AGAIN" },
  { pattern: "ENOTFOUND", code: "ENOTFOUND" },
  { pattern: "Connection terminated", code: "connection_terminated" },
  {
    pattern: "timeout exceeded when trying to connect",
    code: "pool_connect_timeout",
  },
  { pattern: "timeout expired", code: "timeout_expired" },
];

/** Maximum depth for cause-chain traversal to guard against circular references */
const MAX_CAUSE_DEPTH = 5;

/**
 * Determine whether a database error is transient (i.e. retrying may succeed).
 *
 * Checks the error itself and, for DrizzleQueryError wrappers, recursively
 * checks the underlying cause (bounded to {@link MAX_CAUSE_DEPTH} levels).
 * @public — exported for testability
 */
export function isTransientDbError(error: unknown): boolean {
  return getTransientDbErrorCode(error) !== null;
}

/**
 * Resolve a transient database error to a stable, low-cardinality code
 * (e.g. "EAI_AGAIN", "ECONNREFUSED", "pool_connect_timeout", or a SQLSTATE
 * connection code). Returns null for non-transient errors.
 *
 * Used to fingerprint transient connectivity failures in error tracking so
 * one outage groups into one issue per root cause instead of one issue per
 * query that happened to be in flight.
 */
export function getTransientDbErrorCode(
  error: unknown,
  depth = 0,
): string | null {
  if (!(error instanceof Error)) return null;
  if (depth > MAX_CAUSE_DEPTH) return null;

  // Check PostgreSQL error code (set by node-postgres on query errors)
  const pgCode = (error as Error & { code?: string }).code;
  if (pgCode && TRANSIENT_PG_CODES.has(pgCode)) return pgCode;

  // Check error message for known transient patterns
  const message = error.message;
  const matched = TRANSIENT_ERROR_PATTERNS.find(({ pattern }) =>
    message.includes(pattern),
  );
  if (matched) return matched.code;

  // DrizzleQueryError wraps the underlying pg error as `cause`
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause) return getTransientDbErrorCode(cause, depth + 1);

  return null;
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
 * @public — exported for testability
 */
export async function withDbRetry<T>(
  fn: () => Promise<T>,
  options?: { maxRetries?: number; budgetMs?: number },
): Promise<T> {
  const maxRetries = options?.maxRetries ?? MAX_RETRIES;
  const budgetMs = options?.budgetMs ?? RETRY_BUDGET_MS;
  const startedAt = Date.now();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const delay = calculateBackoff(attempt);
      const withinBudget = Date.now() - startedAt + delay <= budgetMs;
      if (isTransientDbError(error) && attempt < maxRetries && withinBudget) {
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

/**
 * Retry a full database transaction callback on transient connection errors.
 *
 * Transaction retries must wrap the whole transaction because checked-out
 * transaction clients are not covered by the pool.query() wrapper.
 * @public — exported for testability and standalone Drizzle clients.
 */
export async function withTransactionRetry<T>(
  runTransaction: () => Promise<T>,
): Promise<T> {
  return withDbRetry(runTransaction);
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

let dbErrorSafetyNetInstalled = false;

/**
 * Install process-level handlers that swallow transient pg connection errors
 * instead of letting them crash the backend.
 *
 * pg.Pool already emits `error` for idle-client failures, and createPool()
 * installs a listener for that. Yet in practice errors still escape — observed
 * during a Postgres OOMKilled restart, where the `BoundPool` emitted an
 * `error` event that surfaced as an uncaught exception, terminating the
 * Node process with exit code 1.
 *
 * This safety net inspects every `uncaughtException` / `unhandledRejection`
 * via {@link isTransientDbError}. Transient pg/socket errors are logged and
 * swallowed — the next pool.query() reconnects naturally. All other errors
 * fall through to the default behavior (log + exit) so we never mask real
 * bugs.
 *
 * Idempotent — multiple calls are no-ops.
 */
export function installDbErrorSafetyNet(): void {
  if (dbErrorSafetyNetInstalled) return;
  dbErrorSafetyNetInstalled = true;

  process.on("uncaughtException", (err) => {
    if (isTransientDbError(err)) {
      logger.error(
        { err },
        "Swallowed transient DB error at process level; pool will reconnect",
      );
      return;
    }
    logger.fatal({ err }, "Uncaught exception, exiting");
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    if (isTransientDbError(reason)) {
      logger.error(
        { err: reason },
        "Swallowed transient DB rejection at process level; pool will reconnect",
      );
      return;
    }
    logger.fatal({ err: reason }, "Unhandled promise rejection, exiting");
    process.exit(1);
  });
}
