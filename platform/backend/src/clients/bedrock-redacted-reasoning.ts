import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import type { LanguageModelMiddleware } from "ai";

/**
 * Makes *redacted* extended thinking survive the trip from Bedrock through
 * @ai-sdk/amazon-bedrock — the encrypted reasoning blob a model emits when its
 * own chain of thought trips a safety filter.
 *
 * The installed provider package mishandles it twice, and a turn only works
 * once both are patched:
 *
 *  1. The Converse API spells that union member `redactedContent`
 *     (`ReasoningContentBlockDelta` while streaming, `ReasoningContentBlock` in
 *     a non-streaming response), but the package models it as `data` /
 *     `redactedReasoning.data`. Its `BedrockStreamSchema` is a closed union of
 *     `{text} | {signature} | {data}`, so a real delta matches no member and
 *     the turn fails with `AI_TypeValidationError: Type validation failed`,
 *     which the chat renders in place of the response.
 *
 *  2. Even under the name it accepts, the package enqueues a bare
 *     `reasoning-delta`: it only opens a reasoning block (and emits the
 *     `reasoning-start` the AI SDK core requires) from a *non-empty text*
 *     delta. A wholly redacted block has no text, so the delta arrives
 *     orphaned and the core rejects it with "reasoning part <id> not found".
 *     `@ai-sdk/anthropic` gets this right for the same concept — its
 *     `redacted_thinking` case emits `reasoning-start` carrying
 *     `providerMetadata.anthropic.redactedData` and empty reasoning text — so
 *     the repair below reproduces that shape rather than inventing one.
 *
 * Where each half lives is forced by where the break is. (1) has to happen
 * before the package parses, and `fetch` is the only hook the AI SDK exposes
 * that early — the same reason `createOllamaNativeFetch` and
 * `createAnthropicThinkingDisplayFetch` in `llm-client.ts` sit there. (2) is
 * about the parts the package emits, so it is middleware.
 *
 * TEMPORARY. Both bugs are fixed upstream in @ai-sdk/amazon-bedrock 4.0.158
 * (published 2026-08-20): its stream schema accepts `redactedContent`, and
 * every reasoning branch now opens the block before emitting a delta. That
 * release clears this repo's 7-day `minimumReleaseAge` on 2026-08-27, and the
 * exclusion list is reserved for HIGH-severity CVE fixes, so the upgrade could
 * not ship here. On or after that date, bump the dependency and delete this
 * file, its test, and the two lines wiring it into `providerModelConfigs`
 * (nothing else imports it). `bedrock-redacted-reasoning.test.ts` keeps an
 * unwrapped control that starts failing the moment the installed package
 * handles the field, so the upgrade cannot land silently while this remains.
 *
 * Both halves are confined to Archestra's own client. The LLM proxy keeps
 * emitting the Converse API's own field name, so clients that read Bedrock's
 * documented shape still see it.
 *
 * The proxy carries the opposite rewrite for *requests*
 * (`normalizeRedactedReasoning` in `routes/proxy/adapters/bedrock.ts`), which
 * looks like the same mapping and is not: that one is the proxy speaking the
 * Converse API correctly and stays whatever the package does, while everything
 * here exists only until the package accepts Bedrock's own field. Deleting
 * this file must not disturb it.
 */

// Bedrock's own name for the encrypted-reasoning union member, in both the
// streaming delta and the non-streaming content block.
const AWS_REDACTED_FIELD = "redactedContent";
// The provider package's names for the same value.
const SDK_DELTA_FIELD = "data";
const SDK_BLOCK_FIELD = "redactedReasoning";

const EVENT_STREAM_MEDIA_TYPE = "application/vnd.amazon.eventstream";
const JSON_MEDIA_TYPE = "application/json";

// AWS event-stream frames are length-prefixed with a big-endian uint32 that
// counts the prefix itself, so anything under the 4-byte header is malformed.
const FRAME_PREFIX_BYTES = 4;

const eventStreamCodec = new EventStreamCodec(toUtf8, fromUtf8);

/**
 * Wraps a `fetch` so Bedrock's redacted-reasoning field reaches
 * @ai-sdk/amazon-bedrock under the name its schemas accept.
 *
 * Applies to both Bedrock paths, because both parse with the same schemas: the
 * proxied one (chat, where the response is Archestra's own re-encoded Converse
 * stream) and the direct one (built-in subagents and knowledge base, straight
 * from AWS). Responses that carry no redacted reasoning — the overwhelming
 * majority — are forwarded byte for byte.
 */
export function createBedrockRedactedReasoningFetch(
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);

    if (!response.ok || !response.body) {
      return response;
    }

    const mediaType = response.headers.get("content-type") ?? "";

    if (mediaType.includes(EVENT_STREAM_MEDIA_TYPE)) {
      return new Response(
        response.body.pipeThrough(createEventStreamRewriter()),
        responseInitFrom(response),
      );
    }

    if (mediaType.includes(JSON_MEDIA_TYPE)) {
      const text = await response.text();
      return new Response(
        rewriteConverseResponseBody(text),
        responseInitFrom(response),
      );
    }

    return response;
  };
}

/**
 * Opens the reasoning block that @ai-sdk/amazon-bedrock forgets, so a reasoning
 * delta it emits without a preceding `reasoning-start` is not rejected by the
 * AI SDK core.
 *
 * Redacted reasoning is what makes this reachable — it is the only block with
 * no text delta to open it — but the same gap exists for a signature-only
 * block, and the repair is keyed on the orphan rather than on the reason for
 * it. A block the package opens itself is left entirely alone; one opened here
 * is closed as soon as its run of deltas ends, so blocks still nest in order.
 */
export function bedrockOrphanReasoningMiddleware(): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    wrapStream: async ({ doStream }) => {
      const { stream, ...rest } = await doStream();
      return {
        stream: stream.pipeThrough(createOrphanReasoningRepair()),
        ...rest,
      };
    },
  };
}

// =============================================================================
// INTERNAL — stream-part repair
// =============================================================================

// The provider-level parts middleware sees. `ai` re-exports the middleware type
// but not this one, and @ai-sdk/provider is not a direct dependency, so it is
// recovered from the middleware's own signature.
type LanguageModelStreamPart =
  Awaited<
    ReturnType<NonNullable<LanguageModelMiddleware["wrapStream"]>>
  >["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

function createOrphanReasoningRepair(): TransformStream<
  LanguageModelStreamPart,
  LanguageModelStreamPart
> {
  // Blocks the provider opened itself, and blocks opened here on its behalf.
  const providerOpened = new Set<string>();
  let repaired: string | null = null;

  function closeRepaired(
    controller: TransformStreamDefaultController<LanguageModelStreamPart>,
  ) {
    if (repaired !== null) {
      controller.enqueue({ type: "reasoning-end", id: repaired });
      repaired = null;
    }
  }

  return new TransformStream({
    transform(part, controller) {
      if (part.type === "reasoning-start") {
        closeRepaired(controller);
        providerOpened.add(part.id);
        controller.enqueue(part);
        return;
      }

      if (part.type === "reasoning-delta") {
        if (providerOpened.has(part.id)) {
          closeRepaired(controller);
        } else if (repaired !== part.id) {
          closeRepaired(controller);
          repaired = part.id;
          // Mirror @ai-sdk/anthropic: the redacted payload rides on the block's
          // start, so a consumer reading only `reasoning-start` still gets it.
          controller.enqueue({
            type: "reasoning-start",
            id: part.id,
            providerMetadata: part.providerMetadata,
          });
        }
        controller.enqueue(part);
        return;
      }

      // `reasoning-end` never arrives for a block the provider did not open —
      // it closes only what it tracks — so anything else ends our run.
      closeRepaired(controller);
      controller.enqueue(part);
    },

    flush(controller) {
      closeRepaired(controller);
    },
  });
}

// =============================================================================
// INTERNAL — wire rewriting
// =============================================================================

/**
 * Response init for a body we rebuilt. `content-length` describes the bytes
 * Bedrock sent, which a rewrite invalidates, and `content-encoding` describes
 * a compression `fetch` has already undone — both would misdescribe what the
 * caller now reads.
 */
function responseInitFrom(response: Response): ResponseInit {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");

  return {
    status: response.status,
    statusText: response.statusText,
    headers,
  };
}

/**
 * Re-frames a Converse event stream, rewriting only `contentBlockDelta` frames
 * that carry a redacted-reasoning delta. Every other frame — and any frame we
 * cannot decode — is passed through as the original bytes, so the padding and
 * header ordering Bedrock chose survive untouched.
 */
function createEventStreamRewriter(): TransformStream<Uint8Array, Uint8Array> {
  let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);

  return new TransformStream({
    transform(chunk, controller) {
      buffer = concatBytes(buffer, chunk);

      while (buffer.length >= FRAME_PREFIX_BYTES) {
        const frameLength = new DataView(
          buffer.buffer,
          buffer.byteOffset,
          buffer.byteLength,
        ).getUint32(0, false);

        // A length that cannot describe a frame would spin this loop forever;
        // hand the remainder over untouched and let the consumer's own decoder
        // report it.
        if (frameLength < FRAME_PREFIX_BYTES) {
          controller.enqueue(buffer);
          buffer = new Uint8Array(0);
          return;
        }

        if (buffer.length < frameLength) {
          break;
        }

        const frame = buffer.slice(0, frameLength);
        buffer = buffer.slice(frameLength);
        controller.enqueue(rewriteEventStreamFrame(frame));
      }
    },

    flush(controller) {
      if (buffer.length > 0) {
        controller.enqueue(buffer);
      }
    },
  });
}

function rewriteEventStreamFrame(frame: Uint8Array): Uint8Array {
  let decoded: ReturnType<typeof eventStreamCodec.decode>;
  try {
    decoded = eventStreamCodec.decode(frame);
  } catch {
    return frame;
  }

  if (decoded.headers[":event-type"]?.value !== "contentBlockDelta") {
    return frame;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(decoded.body));
  } catch {
    return frame;
  }

  const delta = asRecord(asRecord(payload)?.delta);
  const reasoningContent = asRecord(delta?.reasoningContent);
  const redacted = reasoningContent?.[AWS_REDACTED_FIELD];

  if (
    !delta ||
    !reasoningContent ||
    typeof redacted !== "string" ||
    SDK_DELTA_FIELD in reasoningContent
  ) {
    return frame;
  }

  const { [AWS_REDACTED_FIELD]: _dropped, ...rest } = reasoningContent;
  const rewritten = {
    ...(payload as Record<string, unknown>),
    delta: {
      ...delta,
      reasoningContent: { ...rest, [SDK_DELTA_FIELD]: redacted },
    },
  };

  try {
    return eventStreamCodec.encode({
      headers: decoded.headers,
      body: fromUtf8(JSON.stringify(rewritten)),
    });
  } catch {
    return frame;
  }
}

/**
 * Rewrites the redacted-reasoning block of a non-streaming Converse response.
 * Returns the original text whenever there is nothing to change, so a body that
 * is not a Converse response (an error envelope, an embeddings result) is
 * forwarded verbatim.
 */
function rewriteConverseResponseBody(text: string): string {
  if (!text.includes(AWS_REDACTED_FIELD)) {
    return text;
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return text;
  }

  const message = asRecord(asRecord(asRecord(body)?.output)?.message);
  const content = message?.content;
  if (!Array.isArray(content)) {
    return text;
  }

  let changed = false;
  const rewrittenContent = content.map((block) => {
    const reasoningContent = asRecord(asRecord(block)?.reasoningContent);
    const redacted = reasoningContent?.[AWS_REDACTED_FIELD];

    if (
      !reasoningContent ||
      typeof redacted !== "string" ||
      SDK_BLOCK_FIELD in reasoningContent
    ) {
      return block;
    }

    changed = true;
    const { [AWS_REDACTED_FIELD]: _dropped, ...rest } = reasoningContent;
    return {
      ...(block as Record<string, unknown>),
      reasoningContent: {
        ...rest,
        [SDK_BLOCK_FIELD]: { [SDK_DELTA_FIELD]: redacted },
      },
    };
  });

  if (!changed) {
    return text;
  }

  const source = body as Record<string, unknown>;
  return JSON.stringify({
    ...source,
    output: {
      ...(source.output as Record<string, unknown>),
      message: { ...message, content: rewrittenContent },
    },
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function concatBytes(
  left: Uint8Array,
  right: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left);
  merged.set(right, left.length);
  return merged;
}
