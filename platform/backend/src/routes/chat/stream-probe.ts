// Probes a streamText `fullStream` just far enough to decide whether the turn
// will produce anything renderable, so the chat route can silently retry a
// clean-but-empty response before committing the stream to the client.
//
// It pulls the stream iterator manually (never via `for await`) and returns
// without calling `iterator.return()` — an early `for await` break would cancel
// the underlying generation and break the subsequent `toUIMessageStream` merge.

import { type ModelMessage, streamText } from "ai";
import logger from "@/logging";
import {
  parseMaxInputTokens,
  trimMessagesToTokenLimit,
} from "./context-trimming";
import { EmptyModelResponseError } from "./errors";

export type ChatStreamTextConfig = Parameters<typeof streamText>[0] & {
  messages: ModelMessage[];
};

/**
 * Run streamText, probing each attempt's stream for its first renderable event
 * before the caller merges it to the client. This lets us, before anything
 * reaches the user:
 *   - trim + retry on a context-length rejection (vLLM/LiteLLM), and
 *   - silently retry a clean-but-empty response (a stupid-model / inference
 *     glitch), then surface a stream error if it persists.
 * tee() buffers the stream, so consuming the probe prefix does not drop events
 * from the caller's toUIMessageStream merge. Returning on the first
 * *renderable* event (not first text) keeps Gemini's tool-call-before-text
 * turns streaming the tool indicator promptly.
 *
 * A probed error other than a trimmable context-length rejection returns the
 * errored result so the caller's merge surfaces it through the existing
 * toUIMessageStream onError (preserving e.g. unavailable-tool handling);
 * tee() replays the error.
 */
export async function streamTextWithRecovery(params: {
  config: ChatStreamTextConfig;
  conversationId: string;
  /**
   * Fires when empty-response retries exhaust, right before the
   * EmptyModelResponseError throw — i.e. while nothing has been merged to the
   * client yet, so the caller can persist the user messages it would
   * otherwise lose.
   */
  onEmptyResponseExhausted: () => Promise<void>;
}): Promise<ReturnType<typeof streamText>> {
  const { config, conversationId, onEmptyResponseExhausted } = params;

  const MAX_EMPTY_RESPONSE_ATTEMPTS = 3;
  // a still-too-long trimmed payload reproduces the same context error (trim
  // is deterministic from the unchanged messages), so cap trim retries to
  // avoid an unbounded loop; on the cap we fall through to the merge and let
  // the existing onError surface it.
  const MAX_CONTEXT_TRIM_ATTEMPTS = 1;
  let emptyResponseAttempts = 0;
  let contextTrimAttempts = 0;
  // the config the loop retries from; trim replaces its messages so a later
  // empty-response retry reuses the trimmed payload instead of resending the
  // original (too-large) one.
  let currentConfig: ChatStreamTextConfig = config;
  let result = streamText(currentConfig);

  while (true) {
    const probe = await probeFirstRenderableEvent(
      result.fullStream[Symbol.asyncIterator](),
    );

    if (probe.kind === "renderable" || probe.kind === "aborted") {
      return result;
    }

    if (probe.kind === "error") {
      const maxTokens = parseMaxInputTokens(probe.error);
      if (
        maxTokens !== null &&
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
            maxTokens,
            originalMessages: config.messages.length,
            trimmedMessages: trimmed.length,
            conversationId,
          },
          "[ContextTrimming] retrying with trimmed messages",
        );
        currentConfig = {
          ...currentConfig,
          messages: trimmed,
        };
        result = streamText(currentConfig);
        continue;
      }
      return result;
    }

    // probe.kind === "empty": the provider finished with no content.
    emptyResponseAttempts++;
    const canRetryEmptyResponse =
      isRetryableEmptyFinishReason(probe.finishReason) &&
      emptyResponseAttempts < MAX_EMPTY_RESPONSE_ATTEMPTS;
    if (canRetryEmptyResponse) {
      logger.warn(
        {
          conversationId,
          finishReason: probe.finishReason,
          rawFinishReason: probe.rawFinishReason,
          attempt: emptyResponseAttempts,
        },
        "[EmptyResponse] model produced no content, retrying",
      );
      result = streamText(currentConfig);
      continue;
    }

    // Exhausted retries (or a non-retryable finishReason): treat the empty
    // turn as a stream error.
    await onEmptyResponseExhausted();
    throw new EmptyModelResponseError({
      finishReason: probe.finishReason,
      rawFinishReason: probe.rawFinishReason,
      attempts: emptyResponseAttempts,
    });
  }
}

export type StreamProbeEvent = {
  type: string;
  finishReason?: unknown;
  rawFinishReason?: unknown;
  error?: unknown;
};

export type StreamProbeOutcome =
  | { kind: "renderable" }
  | { kind: "empty"; finishReason: string; rawFinishReason?: string }
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
          ...(typeof event.rawFinishReason === "string" && {
            rawFinishReason: event.rawFinishReason,
          }),
        };
      // control parts (start, start-step, finish-step, text-end, ...) carry no
      // content on their own — keep pulling until content, finish, or error.
      default:
        break;
    }
  }
}
