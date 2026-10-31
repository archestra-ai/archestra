import { sql } from "drizzle-orm";
import { type Transaction, withDbTransaction } from "@/database";

/**
 * Serialises refreshes of one subscription credential across every replica: a
 * transaction-scoped Postgres advisory lock keyed by provider and key id,
 * released when the transaction ends.
 *
 * `run` receives the transaction and must do all of its reads and the
 * write-back through it: the write then commits before the lock is released,
 * and no query runs outside the transaction while it is open (PGlite, which
 * backs the tests, has a single connection and would deadlock on one). The
 * caller holds a pooled connection for the whole run, including any network
 * call made under the lock, so keep those bounded.
 *
 * `run` can execute more than once: `withDbTransaction` retries the whole
 * callback on transient database failures. Anything in it with an external
 * side effect must be safe to repeat, or be remembered by the caller across
 * attempts so a retry reuses the first attempt's outcome.
 */
export function withSubscriptionCredentialLock<Result>(params: {
  provider: string;
  providerApiKeyId: string;
  run: (transaction: Transaction) => Promise<Result>;
}): Promise<Result> {
  return withDbTransaction(async (transaction) => {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${params.provider}-subscription:${params.providerApiKeyId}`}, 0))`,
    );
    return params.run(transaction);
  });
}
