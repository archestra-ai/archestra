// The shared agent-run streamText primitive for every agent execution surface
// (interactive chat SSE, headless/A2A, scheduled, ChatOps). It owns the
// `streamText` invocation, the empty/abortive/context-length recovery loop, and
// the stream-level `onError` capture — but not the stop policy: each caller
// passes its own `stopWhen` in `config` (this module only exports the shared
// `MAX_AGENT_STEPS`).
//
// It probes a streamText `fullStream` just far enough to decide whether the turn
// will produce anything renderable, so a caller can silently retry a clean-but-
// empty response before committing the stream to the consumer.
//
// It pulls the stream iterator manually (never via `for await`) and returns
// without calling `iterator.return()` — an early `for await` break would cancel
// the underlying generation and break the subsequent `toUIMessageStream` merge.

import { streamText } from "ai";
import logger from "@/logging";
import {
  parseMaxInputTokens,
  trimMessagesToTokenLimit,
} from "@/routes/chat/context-trimming";
import { EmptyModelResponseError } from "@/routes/chat/errors";

// Maximum agent steps (tool round-trips) per run, shared by every surface. The
// primitive does not inject this — callers pass `stopWhen: stepCountIs(MAX_AGENT_STEPS)`
// (plus any surface-specific stops, e.g. chat's swap-agent conditions).
export const MAX_AGENT_STEPS = 500;

type StreamTextConfig = Parameters<typeof streamText>[0];

/**
 * Run streamText, probing each attempt's stream for its first renderable event
 * before the caller merges it to the consumer. This lets us, before anything
 * reaches the consumer:
 *   - trim + retry on a context-length rejection (vLLM/LiteLLM) — `messages`
 *     input only; a `prompt`-only run skips trimming,
 *   - silently retry a clean-but-empty response (a stupid-model / inference
 *     glitch), then surface a stream error if it persists, and
 *   - retry an abortive tool call (the model started streaming tool input but
 *     the stream ended before a completed `tool-call`), then surface the
 *     existing IncompleteToolCall error if it persists.
 * The AI SDK internally buffers `fullStream` per accessor, so reading the probe
 * prefix here does not drop events from the caller's own consumers (its
 * toUIMessageStream merge, `.text`/`.usage`/`.finishReason`). Commit happens on
 * the first *committing* event — content or a completed `tool-call`, not the
 * opening `tool-input-start` — so an abortive tool call is caught before
 * anything reaches the consumer; the cost is a slightly later tool indicator.
 *
 * A probed error other than a trimmable context-length rejection returns the
 * errored result so the caller's merge surfaces it through the existing
 * toUIMessageStream onError (preserving e.g. unavailable-tool handling); the
 * buffered stream replays the error to the caller's consumers.
 *
 * A stream-level `onError` is injected so the committed attempt's error is
 * captured (exposed via `getCapturedStreamError`, used by A2A to map a generic
 * NoOutputGeneratedError to its real cause). The capture is reset before each
 * attempt so a discarded retry's error never leaks into the committed mapping.
 * The injected callback chains to any caller `config.onError`; if none is set it
 * logs the error, preserving the observability the AI-SDK default console.error
 * gave.
 */
export async function runAgentStream(params: {
  config: StreamTextConfig;
  recovery?: {
    logContext?: Record<string, unknown>;
    /**
     * Fires when empty-response retries exhaust, right before the
     * EmptyModelResponseError throw — i.e. while nothing has been merged to the
     * consumer yet, so the caller can persist state it would otherwise lose.
     */
    onEmptyResponseExhausted?: () => Promise<void>;
  };
}): Promise<{
  result: ReturnType<typeof streamText>;
  getCapturedStreamError: () => unknown;
}> {
  const { config, recovery } = params;
  const logContext = recovery?.logContext ?? {};

  const MAX_EMPTY_RESPONSE_ATTEMPTS = 3;
  // a still-too-long trimmed payload reproduces the same context error (trim
  // is deterministic from the unchanged messages), so cap trim retries to
  // avoid an unbounded loop; on the cap we fall through to the merge and let
  // the existing onError surface it.
  const MAX_CONTEXT_TRIM_ATTEMPTS = 1;
  // a truncated tool call is usually a transient provider glitch; one retry
  // recovers most. On the cap we return the abortive result so the abortive-turn
  // tracker surfaces IncompleteToolCall, the same outcome as before this retry.
  const MAX_ABORTIVE_TOOL_CALL_ATTEMPTS = 2;
  let emptyResponseAttempts = 0;
  let contextTrimAttempts = 0;
  let abortiveToolCallAttempts = 0;

  // Capture only the committed attempt's stream error. Reset before each
  // streamText call so a discarded retry's error never leaks into the mapping.
  let capturedStreamError: unknown;
  const callerOnError = config.onError;
  const onError = (event: { error: unknown }) => {
    capturedStreamError = event.error;
    if (callerOnError) {
      return callerOnError(event);
    }
    logger.error(
      { ...logContext, error: event.error },
      "[AgentRunStream] stream error",
    );
  };

  // the config the loop retries from; trim replaces its messages so a later
  // empty-response retry reuses the trimmed payload instead of resending the
  // original (too-large) one.
  let currentConfig: StreamTextConfig = { ...config, onError };
  // Reset before each attempt so a discarded retry's error never leaks into the
  // committed mapping. This is safe only because the loop always probes an
  // attempt to a terminal event (finish/error/done) before deciding to retry —
  // a discarded stream's onError therefore fires during that probe, before the
  // next reset. Retrying *before* reaching a terminal probe event would break
  // the "only the committed attempt's error is captured" guarantee.
  const runAttempt = (): ReturnType<typeof streamText> => {
    capturedStreamError = undefined;
    return streamText(currentConfig);
  };
  let result = runAttempt();

  while (true) {
    const probe = await probeFirstRenderableEvent(
      result.fullStream[Symbol.asyncIterator](),
    );

    if (probe.kind === "renderable" || probe.kind === "aborted") {
      return { result, getCapturedStreamError: () => capturedStreamError };
    }

    if (probe.kind === "error") {
      const maxTokens = parseMaxInputTokens(probe.error);
      if (
        maxTokens !== null &&
        Array.isArray(config.messages) &&
        contextTrimAttempts < MAX_CONTEXT_TRIM_ATTEMPTS
      ) {
        contextTrimAttempts++;
        const trimmed = trimMessagesToTokenLimit({
          messages: config.messages,
          maxTokens,
          systemPrompt:
            typeof config.system === "string" ? config.system : undefined,
        });
        logger.info(
          {
            ...logContext,
            maxTokens,
            originalMessages: config.messages.length,
            trimmedMessages: trimmed.length,
          },
          "[ContextTrimming] retrying with trimmed messages",
        );
        // `prompt: undefined` keeps the object on the `messages` side of the
        // streamText `messages | prompt` union after the spread (the trim branch
        // only runs when `config.messages` is an array, so there is no prompt).
        currentConfig = {
          ...currentConfig,
          prompt: undefined,
          messages: trimmed,
        };
        result = runAttempt();
        continue;
      }
      return { result, getCapturedStreamError: () => capturedStreamError };
    }

    if (probe.kind === "abortive") {
      abortiveToolCallAttempts++;
      if (abortiveToolCallAttempts < MAX_ABORTIVE_TOOL_CALL_ATTEMPTS) {
        logger.warn(
          {
            ...logContext,
            finishReason: probe.finishReason,
            rawFinishReason: probe.rawFinishReason,
            attempt: abortiveToolCallAttempts,
          },
          "[AbortiveToolCall] tool call truncated mid-stream, retrying",
        );
        result = runAttempt();
        continue;
      }
      // Exhausted: surface the abortive turn through the merge so the
      // abortive-turn tracker emits IncompleteToolCall (unchanged end state).
      logger.warn(
        {
          ...logContext,
          attempts: abortiveToolCallAttempts,
        },
        "[AbortiveToolCall] retries exhausted, surfacing incomplete tool call",
      );
      return { result, getCapturedStreamError: () => capturedStreamError };
    }

    // probe.kind === "empty": the provider finished with no content.
    emptyResponseAttempts++;
    const canRetryEmptyResponse =
      isRetryableEmptyFinishReason(probe.finishReason) &&
      emptyResponseAttempts < MAX_EMPTY_RESPONSE_ATTEMPTS;
    if (canRetryEmptyResponse) {
      logger.warn(
        {
          ...logContext,
          finishReason: probe.finishReason,
          rawFinishReason: probe.rawFinishReason,
          attempt: emptyResponseAttempts,
        },
        "[EmptyResponse] model produced no content, retrying",
      );
      result = runAttempt();
      continue;
    }

    // Exhausted retries (or a non-retryable finishReason): treat the empty
    // turn as a stream error.
    await recovery?.onEmptyResponseExhausted?.();
    throw new EmptyModelResponseError({
      finishReason: probe.finishReason,
      rawFinishReason: probe.rawFinishReason,
      attempts: emptyResponseAttempts,
    });
  }
}

/** @public — exported for testability */
export type StreamProbeEvent = {
  type: string;
  finishReason?: unknown;
  rawFinishReason?: unknown;
  error?: unknown;
};

type StreamProbeOutcome =
  | { kind: "renderable" }
  | { kind: "empty"; finishReason: string; rawFinishReason?: string }
  // The model began streaming a tool call (tool-input-*) but the stream ended
  // before the call completed (no tool-call). Recoverable like an empty turn.
  | { kind: "abortive"; finishReason: string; rawFinishReason?: string }
  | { kind: "aborted" }
  | { kind: "error"; error: unknown };

// fullStream event types that carry (or commit to) content the chat UI renders.
// Seeing any of these means the turn is not empty and should stream normally.
// `tool-input-*` is deliberately absent: a lone tool-input stream that never
// reaches `tool-call` is an abortive (truncated) tool call we want to retry, so
// the probe holds commit until the completed `tool-call` arrives. The cost is a
// slightly later tool indicator (after args finish streaming) for healthy turns.
const RENDERABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "text-start",
  "text-delta",
  "reasoning-start",
  "reasoning-delta",
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

// tool-input streaming events: pending, not committing. Seeing one means a tool
// call started; if the stream ends before a committing `tool-call`, it was
// abortive.
const PENDING_TOOL_INPUT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "tool-input-start",
  "tool-input-delta",
  "tool-input-end",
]);

// finishReasons where a content-free turn is plausibly a transient model/inference
// glitch worth retrying. A *finish* event carrying "error" or "other" with no content
// is a provider-glitch shape, not a real API failure — those reach the probe as error
// parts (or thrown stream errors) before any finish. Gemini's frequent
// MALFORMED_FUNCTION_CALL maps to "error" and OTHER/FINISH_REASON_UNSPECIFIED to
// "other"; some "other" raws may be deterministic, but with the hard attempt cap the
// worst case is two wasted calls before the same error card. Excludes "content-filter"
// (deterministic block) and "tool-calls" (which only finishes that way when tool
// calls — renderable — exist).
const RETRYABLE_EMPTY_FINISH_REASONS: ReadonlySet<string> = new Set([
  "stop",
  "length",
  "unknown",
  "error",
  "other",
]);

/** @public — exported for testability */
export function isRetryableEmptyFinishReason(finishReason: string): boolean {
  return RETRYABLE_EMPTY_FINISH_REASONS.has(finishReason);
}

/** @public — exported for testability */
export async function probeFirstRenderableEvent(
  iterator: AsyncIterator<StreamProbeEvent>,
): Promise<StreamProbeOutcome> {
  // A tool call started streaming (tool-input-*) but has not yet reached a
  // committing `tool-call`. If the stream ends in this state, the turn is
  // abortive rather than merely empty.
  let sawPendingToolInput = false;

  while (true) {
    let result: IteratorResult<StreamProbeEvent>;
    try {
      result = await iterator.next();
    } catch (error) {
      return { kind: "error", error };
    }

    if (result.done) {
      // stream ended without a terminal finish event.
      return sawPendingToolInput
        ? { kind: "abortive", finishReason: "unknown" }
        : { kind: "empty", finishReason: "unknown" };
    }

    const event = result.value;

    if (RENDERABLE_EVENT_TYPES.has(event.type)) {
      return { kind: "renderable" };
    }

    if (PENDING_TOOL_INPUT_EVENT_TYPES.has(event.type)) {
      sawPendingToolInput = true;
      continue;
    }

    switch (event.type) {
      case "error":
        return { kind: "error", error: event.error };
      case "abort":
        return { kind: "aborted" };
      case "finish": {
        const finishReason =
          typeof event.finishReason === "string"
            ? event.finishReason
            : "unknown";
        const rawFinishReason =
          typeof event.rawFinishReason === "string"
            ? { rawFinishReason: event.rawFinishReason }
            : {};
        return sawPendingToolInput
          ? { kind: "abortive", finishReason, ...rawFinishReason }
          : { kind: "empty", finishReason, ...rawFinishReason };
      }
      // control parts (start, start-step, finish-step, text-end, ...) carry no
      // content on their own — keep pulling until content, finish, or error.
      default:
        break;
    }
  }
}
