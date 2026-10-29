/**
 * Whether `error`, or any error in its `cause` chain, is a PostgreSQL deadlock.
 * @public — exported for testability
 */
export function isDeadlockError(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === DEADLOCK_DETECTED) return true;
  }
  return false;
}

/**
 * Run `operation`, running it again once if PostgreSQL aborted it as a
 * deadlock victim. The aborted attempt was rolled back, so the rerun starts
 * clean. `operation` must be a whole statement or a whole transaction.
 */
export async function retryOnceOnDeadlock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= MAX_DEADLOCK_ATTEMPTS || !isDeadlockError(error)) {
        throw error;
      }
    }
  }
}

const DEADLOCK_DETECTED = "40P01";
const MAX_DEADLOCK_ATTEMPTS = 2;
