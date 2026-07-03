/**
 * Registry for fire-and-forget async work (e.g. the usage-tracking update
 * InteractionModel.create launches without awaiting).
 *
 * Production behavior is unchanged — callers still don't await the work. The
 * registry exists so the test teardown can DRAIN it: in shared vitest workers
 * each file swaps in its own PGlite behind the getDb() proxy, so a background
 * promise that outlives its file executes its next query against the *next*
 * file's database — interleaving writes with that file's tests or wedging its
 * connection mid-transaction, which surfaces as a batch of consecutive 30s
 * test timeouts.
 */

/** Track a fire-and-forget promise so tests can drain it at file teardown. */
export function trackBackgroundWork(work: Promise<unknown>): void {
  pending.add(work);
  const remove = () => pending.delete(work);
  work.then(remove, remove);
}

/**
 * Wait until all tracked background work has settled, including work spawned
 * while draining. Errors are ignored — callers own their own error handling.
 *
 * @public — consumed by the shared test setup (src/test/setup.ts), which
 * knip's production pass does not see.
 */
export async function drainBackgroundWork(): Promise<void> {
  while (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
}

const pending = new Set<Promise<unknown>>();
