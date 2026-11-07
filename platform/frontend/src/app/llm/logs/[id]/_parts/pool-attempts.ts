import type { InteractionSummary } from "./session-timeline";

/**
 * The attempts of the pooled request a row belongs to, oldest first.
 *
 * A model pool writes one row per attempt: a member that fails is recorded as
 * `failed_over`, and the next member's attempt is numbered one higher. No id
 * ties the attempts together, so the chain is read from the order of the
 * session's rows for that pool, and only when it cannot be mistaken: the
 * attempts must be next to each other there, and no other request to the
 * same pool in the same session may overlap them in time. Two requests
 * failing over side by side stay unlinked: just the row comes back.
 *
 * `complete`: the chain runs from the first attempt to the one that ended
 * it, so every other member was not needed.
 */
export function poolAttemptsOf(
  row: InteractionSummary,
  requests: InteractionSummary[],
): { attempts: InteractionSummary[]; complete: boolean } {
  const chain = linkedAttempts(row, requests);
  const last = chain[chain.length - 1];
  return {
    attempts: chain,
    complete: chain[0].attempt === 1 && last.attemptOutcome !== "failed_over",
  };
}

/**
 * Whether a pooled row is a retry whose failed attempt is the request row
 * right above it in the list, so the two can be drawn joined.
 */
export function retriesRowAbove(
  row: InteractionSummary,
  above: InteractionSummary | null,
  requests: InteractionSummary[],
): boolean {
  if (!above || !row.attempt || row.attempt < 2) return false;
  const chain = linkedAttempts(row, requests);
  const at = chain.findIndex((attempt) => attempt.id === row.id);
  return at > 0 && chain[at - 1].id === above.id;
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

// The linked chain itself; see `poolAttemptsOf`.
function linkedAttempts(
  row: InteractionSummary,
  requests: InteractionSummary[],
): InteractionSummary[] {
  if (!row.modelPoolId || !row.attempt) return [row];
  const stream = requests.filter(
    (candidate) =>
      candidate.modelPoolId === row.modelPoolId &&
      candidate.sessionId === row.sessionId,
  );
  const index = stream.findIndex((candidate) => candidate.id === row.id);
  if (index < 0) return [row];

  let first = index;
  while (first > 0 && follows(stream[first - 1], stream[first])) {
    first--;
  }
  let last = index;
  while (last < stream.length - 1 && follows(stream[last], stream[last + 1])) {
    last++;
  }
  const chain = stream.slice(first, last + 1);
  if (chain.length === 1) return chain;

  const from = Math.min(...chain.map(startOf));
  const to = Math.max(...chain.map((r) => Date.parse(r.createdAt)));
  const overlapped = stream.some(
    (other, i) =>
      (i < first || i > last) &&
      startOf(other) < to &&
      Date.parse(other.createdAt) > from,
  );
  return overlapped ? [row] : chain;
}

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

function follows(
  previous: InteractionSummary,
  next: InteractionSummary,
): boolean {
  return (
    previous.attemptOutcome === "failed_over" &&
    previous.attempt !== null &&
    next.attempt === previous.attempt + 1
  );
}

function startOf(row: InteractionSummary): number {
  return Date.parse(row.createdAt) - Math.max(0, row.durationMs ?? 0);
}
