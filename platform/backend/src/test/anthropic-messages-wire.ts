import { HttpResponse } from "msw";
import { expect } from "vitest";

// Helpers for tests that serve the Anthropic Messages API with MSW. The real
// `@ai-sdk/anthropic` provider serializes each request, so a test can read the
// cache markers that the upstream would receive.

interface AnthropicWireBlock {
  type: string;
  content?: unknown;
  tool_use_id?: string;
  cache_control?: { type: string; ttl?: string };
}

export interface AnthropicWireRequest {
  tools?: AnthropicWireBlock[];
  system?: AnthropicWireBlock[];
  messages: Array<{ role: string; content: AnthropicWireBlock[] | string }>;
}

/** The request's blocks in Anthropic's render order: tools, system, messages. */
export function anthropicRequestBlocks(
  request: AnthropicWireRequest,
): AnthropicWireBlock[] {
  return [
    ...(request.tools ?? []),
    ...(request.system ?? []),
    ...request.messages.flatMap((message) =>
      typeof message.content === "string" ? [] : message.content,
    ),
  ];
}

/** Anthropic rejects a request that puts a 1-hour marker after a 5-minute one. */
export function expectLongerTtlFirst(params: {
  request: AnthropicWireRequest;
  label: string;
}): void {
  let sawFiveMinuteMarker = false;
  for (const block of anthropicRequestBlocks(params.request)) {
    if (!block.cache_control) continue;
    if (block.cache_control.ttl === "1h") {
      expect(
        sawFiveMinuteMarker,
        `${params.label} puts a 1h marker after a 5m marker`,
      ).toBe(false);
    } else {
      sawFiveMinuteMarker = true;
    }
  }
}

/** A streamed Messages API response with one text or tool_use block. */
export function anthropicStreamResponse(params: {
  model: string;
  block:
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown };
}): Response {
  const { block } = params;
  const isToolUse = block.type === "tool_use";
  const events = [
    {
      type: "message_start",
      message: {
        id: `msg_${crypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        model: params.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: isToolUse
        ? { type: "tool_use", id: block.id, name: block.name, input: {} }
        : { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: isToolUse
        ? {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          }
        : { type: "text_delta", text: block.text },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: {
        stop_reason: isToolUse ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: 10 },
    },
    { type: "message_stop" },
  ];
  return new HttpResponse(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}
