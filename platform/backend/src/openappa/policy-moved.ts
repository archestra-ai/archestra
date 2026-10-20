import logger from "@/logging";

/**
 * Every open conversation of an organization decides its next call under the
 * organization's current policy revision. A dispatch that carried an older
 * policy, or that was decided while another backend replica published a newer
 * one, appends nothing and fails with the `policy_moved` code. Read the policy again and
 * dispatch again: the retry decides at the new revision.
 */

/**
 * Whether `error` reports that the organization's policy moved past the one the
 * dispatch carried: the `policy_moved` code the native binding stamps, or, from
 * a runtime that does not class the refusal yet, the runtime's own refusal text.
 */
export function isPolicyMoved(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ((error as { code?: unknown }).code === "policy_moved") return true;
  return RUNTIME_POLICY_MOVED.test(error.message);
}

/**
 * Runs `run` once, and again while it fails with a moved policy, at most
 * `MAX_ATTEMPTS` times in all. No attempt starts past `DEADLINE_MS`: a wait
 * that would end past it is not taken, and a wait that overran it, as a timer
 * can under load, ends the retries. Each retry waits a random time up to an
 * exponentially growing bound, so replicas that met the same publish do not
 * retry together. `attempt` counts from 0; a retry must read the policy again
 * rather than send the one that moved.
 */
export async function retryWhilePolicyMoved<T>(params: {
  run: (attempt: number) => Promise<T>;
  /** Uniform in [0, 1); replaced in tests. */
  random?: () => number;
  /** The clock and the wait; replaced in tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<T> {
  const random = params.random ?? Math.random;
  const now = params.now ?? Date.now;
  const sleep =
    params.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + DEADLINE_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await params.run(attempt);
    } catch (error) {
      if (!isPolicyMoved(error) || attempt + 1 >= MAX_ATTEMPTS) throw error;
      const wait =
        random() * Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
      if (now() + wait > deadline) throw error;
      logger.info(
        { retry: attempt + 1, waitMs: Math.round(wait) },
        "OpenAPPA policy moved under a dispatch; retrying with the policy read again",
      );
      await sleep(wait);
      if (now() > deadline) throw error;
    }
  }
}

// ===

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 50;
const MAX_BACKOFF_MS = 500;
/** Well below any client's request timeout: past it the client retries the 503. */
const DEADLINE_MS = 2_000;

const RUNTIME_POLICY_MOVED =
  /moved to policy revision \d+ while this event was decided; retry it/;
