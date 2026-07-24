/**
 * Regression: the proxy handler calls getRawToolCallEvents() repeatedly and
 * dedupes replayed events by array index, so the adapter must return a stable
 * snapshot. A draining implementation re-based later tool calls to index 0,
 * so with parallel tool calls the second call's start chunk (id + name) was
 * skipped as already streamed and openai-compat consumers (model-router /
 * archestra provider) received a dangling tool call (AbortiveTurn).
 */
import { describe, expect, it } from "vitest";
import { makeAnthropicOpenaiAdapterFactory } from "./anthropic-openai";
import type { AnthropicOpenaiContext } from "./anthropic-openai-translator";

const ctx: AnthropicOpenaiContext = {
  chatcmplId: "chatcmpl-test",
  createdUnix: 0,
  requestedModel: "archestra:test",
} as AnthropicOpenaiContext;

function makeAdapter() {
  return makeAnthropicOpenaiAdapterFactory(ctx).createStreamAdapter();
}

function feedParallelToolCalls(adapter: ReturnType<typeof makeAdapter>) {
  const feed = (chunk: unknown) =>
    adapter.processChunk(chunk as Parameters<typeof adapter.processChunk>[0]);
  feed({ type: "message_start", message: { usage: {} } });
  feed({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_A", name: "run_command" },
  });
  feed({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"cmd":"ls"}' },
  });
  feed({ type: "content_block_stop", index: 0 });
  feed({
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "toolu_B", name: "run_command" },
  });
  feed({
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"cmd":"pwd"}' },
  });
  feed({ type: "content_block_stop", index: 1 });
}

function assembleToolCalls(wire: string[]) {
  const byIndex = new Map<
    number,
    { id?: string; name?: string; args: string }
  >();
  for (const sse of wire) {
    const match = sse.match(/^data: (\{.*\})/m);
    if (!match) continue;
    const toolCall = JSON.parse(match[1]).choices?.[0]?.delta?.tool_calls?.[0];
    if (!toolCall) continue;
    const entry = byIndex.get(toolCall.index) ?? { args: "" };
    if (toolCall.id) entry.id = toolCall.id;
    if (toolCall.function?.name) entry.name = toolCall.function.name;
    if (toolCall.function?.arguments) entry.args += toolCall.function.arguments;
    byIndex.set(toolCall.index, entry);
  }
  return byIndex;
}

describe("AnthropicOpenaiStreamAdapter.getRawToolCallEvents", () => {
  it("returns a stable snapshot across repeated calls", () => {
    const adapter = makeAdapter();
    feedParallelToolCalls(adapter);

    const first = adapter.getRawToolCallEvents();
    const second = adapter.getRawToolCallEvents();
    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });

  it("keeps both parallel tool calls intact under the handler's index-dedupe replay", () => {
    const adapter = makeAdapter();
    const feed = (chunk: unknown) =>
      adapter.processChunk(chunk as Parameters<typeof adapter.processChunk>[0]);
    const streamedEventIndices = new Set<number>();
    const wire: string[] = [];
    const flush = () => {
      const allEvents = adapter.getRawToolCallEvents();
      for (let i = 0; i < allEvents.length; i++) {
        if (!streamedEventIndices.has(i)) {
          wire.push(allEvents[i] as string);
          streamedEventIndices.add(i);
        }
      }
    };

    feed({ type: "message_start", message: { usage: {} } });
    feed({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_A", name: "run_command" },
    });
    feed({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"cmd":"ls"}' },
    });
    flush(); // handler flushes mid-stream once the first call passes policy
    feed({ type: "content_block_stop", index: 0 });
    feed({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_B", name: "run_command" },
    });
    feed({
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"cmd":"pwd"}' },
    });
    flush();

    const byIndex = assembleToolCalls(wire);
    expect(byIndex.get(0)).toMatchObject({
      id: "toolu_A",
      name: "run_command",
    });
    expect(JSON.parse(byIndex.get(0)?.args ?? "")).toEqual({ cmd: "ls" });
    expect(byIndex.get(1)).toMatchObject({
      id: "toolu_B",
      name: "run_command",
    });
    expect(JSON.parse(byIndex.get(1)?.args ?? "")).toEqual({ cmd: "pwd" });
  });
});
