import {
  buildTimeline,
  type InteractionSummary,
  type SessionToolCall,
  type Timeline,
  toolCallSpanKey,
} from "@/app/llm/logs/session/[sessionId]/_parts/session-timeline";

/**
 * The records around one tool call, on an axis of their own. Everything
 * fetched is laid out together first, so the order matches the full trace;
 * then the spans beyond `SPANS_EACH_SIDE` on either side of the call are
 * dropped and the rest re-laid, so the excerpt's bars fill its own width. The
 * call is added when the fetched page missed it, so it is always there.
 */
export function buildExcerptTimeline({
  requests,
  toolCalls,
  call,
}: {
  requests: InteractionSummary[];
  toolCalls: SessionToolCall[];
  call: SessionToolCall;
}): { timeline: Timeline | null; before: number; after: number } {
  const withCall = toolCalls.some((row) => row.id === call.id)
    ? toolCalls
    : [...toolCalls, call];
  const full = buildTimeline({ requests, toolCalls: withCall });
  if (!full) return { timeline: null, before: 0, after: 0 };

  const selfKey = toolCallSpanKey(call.id);
  const index = full.spans.findIndex((span) => span.key === selfKey);
  const center = index >= 0 ? index : full.spans.length - 1;
  const kept = full.spans.slice(
    Math.max(0, center - SPANS_EACH_SIDE),
    center + SPANS_EACH_SIDE + 1,
  );
  const timeline = buildTimeline({
    requests: kept.flatMap((span) =>
      span.type === "request" ? [span.row] : [],
    ),
    toolCalls: kept.flatMap((span) =>
      span.type === "tool" ? [span.call] : [],
    ),
  });
  const at = timeline?.spans.findIndex((span) => span.key === selfKey) ?? -1;
  if (!timeline || at < 0) {
    return { timeline, before: 0, after: 0 };
  }
  return { timeline, before: at, after: timeline.spans.length - at - 1 };
}

// ============================================================================
// Internal helpers
// ============================================================================

/** How many records the excerpt keeps on each side of the call. */
const SPANS_EACH_SIDE = 6;
