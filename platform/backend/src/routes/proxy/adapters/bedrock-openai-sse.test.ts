import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, test } from "@/test";
import {
  createConverseToOpenaiSseEncoder,
  type OpenaiContext,
} from "./bedrock-openai-translator";

const ctx: OpenaiContext = {
  chatcmplId: "chatcmpl-test",
  createdUnix: 1_700_000_000,
  requestedModel: "zai.glm-4.7",
  includeUsageInStream: false,
};

function decode(bytes: Uint8Array | string | Uint8Array[] | null): string {
  if (bytes == null) return "";
  if (typeof bytes === "string") return bytes;
  if (Array.isArray(bytes)) {
    return bytes.map((b) => new TextDecoder().decode(b)).join("");
  }
  return new TextDecoder().decode(bytes);
}

function parseSseChunks(
  bytes: Uint8Array | string | Uint8Array[] | null,
): unknown[] {
  const text = decode(bytes);
  if (!text) return [];
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") {
      out.push("[DONE]");
    } else if (payload) {
      out.push(JSON.parse(payload));
    }
  }
  return out;
}

function chunk<T extends ConverseStreamOutput>(c: T): T {
  return c;
}

describe("sse encoder — events", () => {
  test("messageStart emits a role delta chunk", () => {
    const enc = createConverseToOpenaiSseEncoder(ctx);
    const bytes = enc.encodeBedrockEvent(
      chunk({ messageStart: { role: "assistant" } }),
    );
    const [c] = parseSseChunks(bytes) as Array<Record<string, unknown>>;
    expect(c).toMatchObject({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      model: "zai.glm-4.7",
      choices: [
        {
          index: 0,
          delta: { role: "assistant" },
          finish_reason: null,
        },
      ],
    });
  });

  test("contentBlockDelta.text → content delta", () => {
    const enc = createConverseToOpenaiSseEncoder(ctx);
    const bytes = enc.encodeBedrockEvent(
      chunk({
        contentBlockDelta: {
          contentBlockIndex: 0,
          delta: { text: "hi " },
        },
      }),
    );
    const [c] = parseSseChunks(bytes) as Array<Record<string, unknown>>;
    expect(c).toMatchObject({
      choices: [{ index: 0, delta: { content: "hi " }, finish_reason: null }],
    });
  });

  test("contentBlockStart toolUse → tool_calls opening chunk", () => {
    const enc = createConverseToOpenaiSseEncoder(ctx);
    const bytes = enc.encodeBedrockEvent(
      chunk({
        contentBlockStart: {
          contentBlockIndex: 1,
          start: {
            toolUse: { toolUseId: "t_xyz", name: "get_weather" },
          },
        },
      }),
    );
    const [c] = parseSseChunks(bytes) as Array<Record<string, unknown>>;
    expect(c).toMatchObject({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "t_xyz",
                type: "function",
                function: { name: "get_weather", arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  });

  test("contentBlockDelta.toolUse.input → tool_calls arguments delta", () => {
    const enc = createConverseToOpenaiSseEncoder(ctx);
    // opening
    enc.encodeBedrockEvent(
      chunk({
        contentBlockStart: {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: "t_xyz", name: "f" } },
        },
      }),
    );
    const bytes = enc.encodeBedrockEvent(
      chunk({
        contentBlockDelta: {
          contentBlockIndex: 1,
          delta: { toolUse: { input: '{"city":' } },
        },
      }),
    );
    const [c] = parseSseChunks(bytes) as Array<Record<string, unknown>>;
    expect(c).toMatchObject({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: '{"city":' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  });

  test("contentBlockStop → null (no emission)", () => {
    const enc = createConverseToOpenaiSseEncoder(ctx);
    const bytes = enc.encodeBedrockEvent(
      chunk({ contentBlockStop: { contentBlockIndex: 0 } }),
    );
    expect(bytes).toBeNull();
  });

  test("messageStop → null + stashes finish reason for formatEnd", () => {
    const enc = createConverseToOpenaiSseEncoder(ctx);
    const bytes = enc.encodeBedrockEvent(
      chunk({ messageStop: { stopReason: "tool_use" } }),
    );
    expect(bytes).toBeNull();

    const endBytes = enc.formatEnd();
    const events = parseSseChunks(endBytes);
    // last entry is [DONE]; one before it is the finish chunk
    expect(events[events.length - 1]).toBe("[DONE]");
    const finishChunk = events[events.length - 2] as Record<string, unknown>;
    expect(finishChunk).toMatchObject({
      choices: [{ finish_reason: "tool_calls", delta: {} }],
    });
  });
});

describe("sse encoder — usage", () => {
  test("metadata.usage is suppressed when includeUsageInStream=false", () => {
    const enc = createConverseToOpenaiSseEncoder(ctx);
    const bytes = enc.encodeBedrockEvent(
      chunk({
        metadata: {
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          metrics: { latencyMs: 0 },
        },
      }),
    );
    expect(bytes).toBeNull();
  });

  test("metadata.usage emits a usage-only chunk when includeUsageInStream=true", () => {
    const enc = createConverseToOpenaiSseEncoder({
      ...ctx,
      includeUsageInStream: true,
    });
    const bytes = enc.encodeBedrockEvent(
      chunk({
        metadata: {
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          metrics: { latencyMs: 0 },
        },
      }),
    );
    const [c] = parseSseChunks(bytes) as Array<Record<string, unknown>>;
    expect(c).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  });
});

describe("sse encoder — terminal formatters", () => {
  test("formatEnd with no pending reason emits just [DONE]", () => {
    const enc = createConverseToOpenaiSseEncoder(ctx);
    const events = parseSseChunks(enc.formatEnd());
    expect(events).toEqual(["[DONE]"]);
  });

  test("formatEnd after messageStop emits finish chunk then [DONE]", () => {
    const enc = createConverseToOpenaiSseEncoder(ctx);
    enc.encodeBedrockEvent(chunk({ messageStop: { stopReason: "end_turn" } }));
    const events = parseSseChunks(enc.formatEnd());
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      choices: [{ finish_reason: "stop" }],
    });
    expect(events[1]).toBe("[DONE]");
  });

  test("formatCompleteText emits role, content, finish=stop (discards pending)", () => {
    const enc = createConverseToOpenaiSseEncoder(ctx);
    // pending should not win
    enc.encodeBedrockEvent(chunk({ messageStop: { stopReason: "tool_use" } }));
    const events = parseSseChunks(enc.formatCompleteText("Blocked"));
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      choices: [{ delta: { role: "assistant" }, finish_reason: null }],
    });
    expect(events[1]).toMatchObject({
      choices: [{ delta: { content: "Blocked" }, finish_reason: null }],
    });
    expect(events[2]).toMatchObject({
      choices: [{ delta: {}, finish_reason: "stop" }],
    });

    // After the refusal, formatEnd should not re-emit the stashed tool_use finish
    const endEvents = parseSseChunks(enc.formatEnd());
    expect(endEvents).toEqual(["[DONE]"]);
  });

  test("formatTextDelta emits role delta on first call, plain content delta after", () => {
    const enc = createConverseToOpenaiSseEncoder(ctx);
    const first = parseSseChunks(enc.formatTextDelta("A"));
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({
      choices: [{ delta: { role: "assistant" }, finish_reason: null }],
    });
    expect(first[1]).toMatchObject({
      choices: [{ delta: { content: "A" }, finish_reason: null }],
    });

    const second = parseSseChunks(enc.formatTextDelta("B"));
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      choices: [{ delta: { content: "B" }, finish_reason: null }],
    });
  });

  test("messageStart suppresses the role prepend on first formatTextDelta", () => {
    const enc = createConverseToOpenaiSseEncoder(ctx);
    enc.encodeBedrockEvent(chunk({ messageStart: { role: "assistant" } }));
    const events = parseSseChunks(enc.formatTextDelta("A"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      choices: [{ delta: { content: "A" }, finish_reason: null }],
    });
  });
});

describe("sse encoder — tool-call index tracking", () => {
  test("multiple tool calls get sequential indices 0, 1, ...", () => {
    const enc = createConverseToOpenaiSseEncoder(ctx);
    const a = enc.encodeBedrockEvent(
      chunk({
        contentBlockStart: {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: "t1", name: "f" } },
        },
      }),
    );
    const b = enc.encodeBedrockEvent(
      chunk({
        contentBlockStart: {
          contentBlockIndex: 2,
          start: { toolUse: { toolUseId: "t2", name: "g" } },
        },
      }),
    );
    const [ca] = parseSseChunks(a) as Array<Record<string, unknown>>;
    const [cb] = parseSseChunks(b) as Array<Record<string, unknown>>;
    expect((ca.choices as Loose[])[0].delta.tool_calls[0].index).toBe(0);
    expect((cb.choices as Loose[])[0].delta.tool_calls[0].index).toBe(1);
  });

  test("tool-call arg delta uses the index of the most recent tool, not the block index", () => {
    const enc = createConverseToOpenaiSseEncoder(ctx);
    enc.encodeBedrockEvent(
      chunk({
        contentBlockStart: {
          contentBlockIndex: 1,
          start: { toolUse: { toolUseId: "t1", name: "f" } },
        },
      }),
    );
    enc.encodeBedrockEvent(
      chunk({
        contentBlockStart: {
          contentBlockIndex: 2,
          start: { toolUse: { toolUseId: "t2", name: "g" } },
        },
      }),
    );
    const delta = enc.encodeBedrockEvent(
      chunk({
        contentBlockDelta: {
          contentBlockIndex: 2,
          delta: { toolUse: { input: "{}" } },
        },
      }),
    );
    const [c] = parseSseChunks(delta) as Array<Record<string, unknown>>;
    expect((c.choices as Loose[])[0].delta.tool_calls[0].index).toBe(1);
  });
});

// biome-ignore lint/suspicious/noExplicitAny: test helper only
type Loose = any;
