import type { UIMessageChunk } from "ai";

export interface AbortiveTurnTrackerParams {
  /**
   * Invoked from the transform's `flush()` when the turn ended with a tool call
   * the model started streaming but never completed. Returns the chunk to append
   * (a trailing error), or null to append nothing (e.g. the run was aborted or
   * already errored). It runs while the stream is still open, so the chunk lands
   * in order at the end of the turn — no `execute`-side await that could deadlock
   * on a stream the downstream consumer hasn't started draining yet.
   */
  onUnresolvedToolCall: () => UIMessageChunk | null;
}

// A tool call is "started" at `tool-input-start` and "resolved" once the model
// finishes emitting its input (`tool-input-available`). Approval, MCP
// elicitation, swap-agent stop tools, and normal completions all emit
// `tool-input-available` before any execution pause, so only a genuinely
// abandoned call (e.g. a provider that truncates mid tool-call) stays
// unresolved. This taps the merged UI message stream rather than streamText's
// `onChunk` so it observes the exact chunks the client and persistence see.
export function createAbortiveTurnTracker(
  params: AbortiveTurnTrackerParams,
): TransformStream<UIMessageChunk, UIMessageChunk> {
  const startedToolCallIds = new Set<string>();
  const resolvedToolCallIds = new Set<string>();

  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      recordToolCallLifecycle(chunk, startedToolCallIds, resolvedToolCallIds);
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (!hasUnresolvedToolCall(startedToolCallIds, resolvedToolCallIds)) {
        return;
      }
      const chunk = params.onUnresolvedToolCall();
      if (chunk) {
        controller.enqueue(chunk);
      }
    },
  });
}

function hasUnresolvedToolCall(
  startedToolCallIds: ReadonlySet<string>,
  resolvedToolCallIds: ReadonlySet<string>,
): boolean {
  for (const toolCallId of startedToolCallIds) {
    if (!resolvedToolCallIds.has(toolCallId)) {
      return true;
    }
  }
  return false;
}

function recordToolCallLifecycle(
  chunk: UIMessageChunk,
  startedToolCallIds: Set<string>,
  resolvedToolCallIds: Set<string>,
): void {
  switch (chunk.type) {
    case "tool-input-start":
      startedToolCallIds.add(chunk.toolCallId);
      break;
    case "tool-input-available":
      resolvedToolCallIds.add(chunk.toolCallId);
      break;
    default:
      break;
  }
}
