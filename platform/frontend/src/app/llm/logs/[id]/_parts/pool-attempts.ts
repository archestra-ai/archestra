import type { InteractionSummary } from "./session-timeline";

/**
 * The attempts of the pooled request a row belongs to, oldest first.
 *
 * A model pool writes one row per attempt: a member that fails is recorded as
 * `failed_over` and the next member's attempt is the next row from the same
 * pool, numbered one higher. So the chain is rebuilt from the session's rows
 * around this one. Rows of other pools, sessions or attempts in between (a
 * subagent, the other half of a handoff) are skipped. Returns just the row
 * when its neighbours are not loaded.
 */
export function poolAttemptsOf(
  row: InteractionSummary,
  requests: InteractionSummary[],
): InteractionSummary[] {
  if (!row.modelPoolId || !row.attempt) return [row];
  const index = requests.findIndex((candidate) => candidate.id === row.id);
  if (index < 0) return [row];
  const sameRequest = (candidate: InteractionSummary, attempt: number) =>
    candidate.modelPoolId === row.modelPoolId &&
    candidate.sessionId === row.sessionId &&
    candidate.attempt === attempt;

  const before: InteractionSummary[] = [];
  let cursor = index;
  for (let attempt = row.attempt - 1; attempt >= 1; attempt--) {
    const found = findNear(requests, cursor, -1, (candidate) =>
      sameRequest(candidate, attempt),
    );
    if (found < 0 || requests[found].attemptOutcome !== "failed_over") break;
    before.unshift(requests[found]);
    cursor = found;
  }

  const after: InteractionSummary[] = [];
  cursor = index;
  let last = row;
  for (
    let attempt = row.attempt + 1;
    last.attemptOutcome === "failed_over";
    attempt++
  ) {
    const found = findNear(requests, cursor, 1, (candidate) =>
      sameRequest(candidate, attempt),
    );
    if (found < 0) break;
    last = requests[found];
    after.push(last);
    cursor = found;
  }
  return [...before, row, ...after];
}

/**
 * A failed pool attempt's reason, as the proxy stores it (`rate_limited (429)`),
 * read as a short label and the HTTP status it came with.
 */
export function poolFailureLabel(
  failureReason: string | null | undefined,
): { label: string; status: number | null } | null {
  if (!failureReason) return null;
  const match = /^([a-z_]+)(?:\s*\((\d{3})\))?$/.exec(failureReason.trim());
  if (!match) return { label: failureReason, status: null };
  const [, code, status] = match;
  return {
    label: FAILURE_LABELS[code] ?? code.replaceAll("_", " "),
    status: status ? Number(status) : null,
  };
}

/** `429 · rate limited`, or the label alone when no status came back. */
export function poolFailureText(
  failure: NonNullable<ReturnType<typeof poolFailureLabel>>,
): string {
  return failure.status
    ? `${failure.status} · ${failure.label}`
    : failure.label;
}

// ===

/** How far from a row its next attempt may sit: other traffic interleaves. */
const NEAR_ROWS = 12;

const FAILURE_LABELS: Record<string, string> = {
  rate_limited: "rate limited",
  auth_failed: "auth failed",
  model_not_found: "model not found",
  timeout: "timed out",
  unreachable: "unreachable",
  server_error: "server error",
  key_unavailable: "key unavailable",
  error: "error",
};

function findNear(
  requests: InteractionSummary[],
  from: number,
  step: 1 | -1,
  matches: (candidate: InteractionSummary) => boolean,
): number {
  for (
    let i = from + step, seen = 0;
    i >= 0 && i < requests.length && seen < NEAR_ROWS;
    i += step, seen++
  ) {
    if (matches(requests[i])) return i;
  }
  return -1;
}
