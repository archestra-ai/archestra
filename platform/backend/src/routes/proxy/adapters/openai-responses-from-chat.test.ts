import { describe, expect, it } from "vitest";
import { makeAnthropicOpenaiAdapterFactory } from "./anthropic-openai";
import type { AnthropicOpenaiContext } from "./anthropic-openai-translator";
import { openaiAdapterFactory } from "./openai";
import { makeResponsesFromChatAdapterFactory } from "./openai-responses-from-chat";

const responsesCtx = {
  responseId: "resp-test",
  createdUnix: 0,
  requestedModel: "archestra:test",
};

const anthropicFactory = makeResponsesFromChatAdapterFactory(
  makeAnthropicOpenaiAdapterFactory({
    chatcmplId: "chatcmpl-test",
    createdUnix: 0,
    requestedModel: "archestra:test",
  } as AnthropicOpenaiContext),
  responsesCtx,
);

// Responses has no finish_reason: a turn the model did not finish is
// `incomplete`, and clients such as Codex read `completed` as a whole answer.
describe.each([
  {
    stopReason: "max_tokens",
    status: "incomplete",
    incompleteDetails: { reason: "max_output_tokens" },
    terminal: "response.incomplete",
  },
  {
    stopReason: "model_context_window_exceeded",
    status: "incomplete",
    incompleteDetails: { reason: "max_output_tokens" },
    terminal: "response.incomplete",
  },
  {
    stopReason: "refusal",
    status: "incomplete",
    incompleteDetails: { reason: "content_filter" },
    terminal: "response.incomplete",
  },
  {
    stopReason: "end_turn",
    status: "completed",
    incompleteDetails: null,
    terminal: "response.completed",
  },
])("Responses client of a Claude turn ending in $stopReason", ({
  stopReason,
  status,
  incompleteDetails,
  terminal,
}) => {
  it(`gets status ${status} without streaming`, () => {
    const adapter = anthropicFactory.createResponseAdapter({
      id: "msg-test",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text: "partial", citations: null }],
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 2 },
    });

    expect(adapter.getOriginalResponse()).toMatchObject({
      status,
      incomplete_details: incompleteDetails,
      output: [{ type: "message", status }],
    });
  });

  it(`gets a ${terminal} terminal when streaming`, () => {
    const adapter = anthropicFactory.createStreamAdapter();
    const feed = (chunk: unknown) =>
      adapter.processChunk(chunk as Parameters<typeof adapter.processChunk>[0]);
    feed({
      type: "message_start",
      message: { id: "msg-test", model: "claude-test", usage: {} },
    });
    feed({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    feed({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "partial" },
    });
    feed({ type: "content_block_stop", index: 0 });
    feed({
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 2 },
    });
    feed({ type: "message_stop" });

    const events = parseEvents(adapter.formatEndSSE());
    expect(
      events.find((e) => e.type === "response.output_item.done"),
    ).toMatchObject({ item: { type: "message", status } });
    expect(events.at(-1)).toMatchObject({
      type: terminal,
      response: { status, incomplete_details: incompleteDetails },
    });
  });
});

describe("Responses client of a streamed Chat Completions turn", () => {
  it("gets response.incomplete when the provider stopped on length", () => {
    const adapter = makeResponsesFromChatAdapterFactory(
      openaiAdapterFactory,
      responsesCtx,
    ).createStreamAdapter();
    const feed = (chunk: unknown) =>
      adapter.processChunk(chunk as Parameters<typeof adapter.processChunk>[0]);
    const base = {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 0,
      model: "gpt-test",
    };
    feed({
      ...base,
      choices: [
        { index: 0, delta: { content: "partial" }, finish_reason: null },
      ],
    });
    feed({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "length" }],
    });

    expect(parseEvents(adapter.formatEndSSE()).at(-1)).toMatchObject({
      type: "response.incomplete",
      response: {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
    });
  });
});

function parseEvents(sse: string | Uint8Array): Array<Record<string, unknown>> {
  const text = typeof sse === "string" ? sse : new TextDecoder().decode(sse);
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => JSON.parse(line.slice(6)));
}
