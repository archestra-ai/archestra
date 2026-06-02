// Probes a streamText `fullStream` just far enough to decide whether the turn
// will produce anything renderable, so the chat route can silently retry a
// clean-but-empty response before committing the stream to the client.
//
// It pulls the stream iterator manually (never via `for await`) and returns
// without calling `iterator.return()` — an early `for await` break would cancel
// the underlying generation and break the subsequent `toUIMessageStream` merge.
// This mirrors the existing context-trim first-chunk probe.

export type StreamProbeEvent = {
  type: string;
  finishReason?: unknown;
  error?: unknown;
};

export type StreamProbeOutcome =
  | { kind: "renderable" }
  | { kind: "empty"; finishReason: string }
  | { kind: "aborted" }
  | { kind: "error"; error: unknown };

// fullStream event types that carry (or commit to) content the chat UI renders.
// Seeing any of these means the turn is not empty and should stream normally.
const RENDERABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "text-start",
  "text-delta",
  "reasoning-start",
  "reasoning-delta",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-end",
  "tool-call",
  "tool-result",
  // tool failure, denial, and approval-request parts are all UI-rendered turn
  // state. A resume turn (input arrived in a prior turn) can open with one of
  // these and no preceding tool-input-start, so they must count as renderable.
  "tool-error",
  "tool-output-denied",
  "tool-approval-request",
  "source",
  "file",
]);

// finishReasons where a content-free turn is plausibly a transient model/inference
// glitch worth retrying. Excludes e.g. "content-filter" (deterministic block) and
// "tool-calls" (which only finishes that way when tool calls — renderable — exist).
const RETRYABLE_EMPTY_FINISH_REASONS: ReadonlySet<string> = new Set([
  "stop",
  "length",
  "unknown",
]);

export function isRetryableEmptyFinishReason(finishReason: string): boolean {
  return RETRYABLE_EMPTY_FINISH_REASONS.has(finishReason);
}

export async function probeFirstRenderableEvent(
  iterator: AsyncIterator<StreamProbeEvent>,
): Promise<StreamProbeOutcome> {
  while (true) {
    let result: IteratorResult<StreamProbeEvent>;
    try {
      result = await iterator.next();
    } catch (error) {
      return { kind: "error", error };
    }

    if (result.done) {
      // stream ended without a terminal finish event — nothing renderable seen.
      return { kind: "empty", finishReason: "unknown" };
    }

    const event = result.value;

    if (RENDERABLE_EVENT_TYPES.has(event.type)) {
      return { kind: "renderable" };
    }

    switch (event.type) {
      case "error":
        return { kind: "error", error: event.error };
      case "abort":
        return { kind: "aborted" };
      case "finish":
        return {
          kind: "empty",
          finishReason:
            typeof event.finishReason === "string"
              ? event.finishReason
              : "unknown",
        };
      // control parts (start, start-step, finish-step, text-end, ...) carry no
      // content on their own — keep pulling until content, finish, or error.
      default:
        break;
    }
  }
}
