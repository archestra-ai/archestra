/**
 * Every open conversation of an organization decides its next call under the
 * organization's current policy revision. A dispatch that carried an older
 * policy, or that was decided while another backend replica published a newer
 * one, appends nothing and fails with `POLICY_MOVED`. Read the policy again and
 * dispatch again: the retry decides at the new revision.
 */

/**
 * Whether `error` reports that the organization's policy moved past the one the
 * dispatch carried. The second form is the runtime's own refusal text, which the
 * native binding normally turns into `POLICY_MOVED`.
 */
export function isPolicyMoved(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message === POLICY_MOVED || RUNTIME_POLICY_MOVED.test(message);
}

/**
 * Runs `run` once, and again while it fails with a moved policy, at most
 * `MAX_ATTEMPTS` times in all and never past `DEADLINE_MS`. Each retry waits a
 * random time up to an exponentially growing bound, so replicas that met the
 * same publish do not retry together. `attempt` counts from 0; a retry must
 * read the policy again rather than send the one that moved.
 */
export async function retryWhilePolicyMoved<T>(params: {
  run: (attempt: number) => Promise<T>;
  /** Uniform in [0, 1); replaced in tests. */
  random?: () => number;
}): Promise<T> {
  const random = params.random ?? Math.random;
  const deadline = Date.now() + DEADLINE_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await params.run(attempt);
    } catch (error) {
      if (!isPolicyMoved(error) || attempt + 1 >= MAX_ATTEMPTS) throw error;
      const wait =
        random() * Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
      if (Date.now() + wait > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

// ===

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 50;
const MAX_BACKOFF_MS = 500;
/** Well below any client's request timeout: past it the client retries the 503. */
const DEADLINE_MS = 2_000;

/** The runtime's report that the organization's policy moved past the dispatch's. */
const POLICY_MOVED =
  "OpenAPPA published a newer policy revision for this organization; retry the request";

const RUNTIME_POLICY_MOVED =
  /moved to policy revision \d+ while this event was decided; retry it/;
