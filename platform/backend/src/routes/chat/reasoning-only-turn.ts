import type { UIMessageChunk } from "ai";

// A reasoning model can stream its "thinking" and then finish without ever
// producing an answer (no text, no tool call). Because reasoning commits the
// turn — it must stream live, or a long think phase would send no bytes and risk
// a proxy/client idle timeout — the start-of-stream empty-response probe can't
// catch this: the turn opened with renderable (reasoning) content. This taps the
// merged UI message stream and, on stream end, appends the same retryable error a
// cleanly-empty turn would surface, so a "thought but never answered" turn does
// not read as a successful reply. It observes the exact chunks the client and
// persistence see.
export function createReasoningOnlyTurnTracker(params: {
  /**
   * Invoked from the transform's `flush()` when the turn streamed reasoning but
   * produced no text or tool call. Returns the chunk to append (a trailing
   * error), or null to append nothing (e.g. the run was aborted or already
   * errored). It runs while the stream is still open, so the chunk lands in order
   * at the end of the turn.
   */
  onReasoningOnlyTurn: () => UIMessageChunk | null;
}): TransformStream<UIMessageChunk, UIMessageChunk> {
  let sawReasoning = false;
  let sawAnswer = false;

  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    transform(chunk, controller) {
      switch (chunk.type) {
        case "reasoning-start":
        case "reasoning-delta":
          sawReasoning = true;
          break;
        // Any text or a started tool call is an answer. `tool-input-start` counts
        // even if the tool call is later abandoned: that is the abortive-turn
        // tracker's case, not this one, and treating it as an answer here keeps
        // the two guards mutually exclusive (no double error).
        case "text-start":
        case "text-delta":
        case "tool-input-start":
          sawAnswer = true;
          break;
        default:
          break;
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (!sawReasoning || sawAnswer) {
        return;
      }
      const chunk = params.onReasoningOnlyTurn();
      if (chunk) {
        controller.enqueue(chunk);
      }
    },
  });
}
