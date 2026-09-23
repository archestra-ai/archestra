/**
 * `formatToolCallsSSE` — the adapter half of repairing a dispatch-mode agent's
 * direct tool call by re-addressing it to `run_tool`.
 *
 * The proxy cannot edit the buffered raw events: they are provider-native
 * fragments with the name and the argument JSON split across chunks. So each
 * adapter re-emits the turn's calls in its own wire format, and these tests pin
 * that the emitted frames are ones a client can actually accumulate — the
 * failure mode being a silently malformed stream rather than a thrown error.
 */

import { describe, expect, test } from "@/test";
import { anthropicAdapterFactory } from "./anthropic";
import { openaiAdapterFactory } from "./openai";
import { zhipuaiAdapterFactory } from "./zhipuai";

type SseToolCall = {
  index: number;
  id: string;
  type: string;
  function: { name: string; arguments: string };
};

/** The OpenAI chat-completions frame shape these assertions read. */
type OpenAiFrame = {
  choices: Array<{
    delta: { tool_calls?: SseToolCall[] };
    finish_reason: string | null;
  }>;
};

/** The Anthropic messages frame shape these assertions read. */
type AnthropicFrame = {
  type: string;
  index: number;
  content_block?: { type: string; id: string; name: string };
  delta?: { type: string; partial_json: string };
};

const REWRITTEN = [
  {
    id: "call_0",
    name: "archestra__run_tool",
    arguments: JSON.stringify({
      tool_name: "gh-developer-agent__pull_request_read",
      tool_args: { pullNumber: 7 },
    }),
  },
];

/** Parse `data: {...}` payloads out of an SSE frame string. */
function sseData<TFrame>(frames: (string | Uint8Array)[]): TFrame[] {
  return frames
    .flatMap((frame) => String(frame).split("\n"))
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .filter((payload) => payload !== "[DONE]")
    .map((payload) => JSON.parse(payload));
}

describe("OpenAI chat formatToolCallsSSE", () => {
  test("emits one complete tool call the client can accumulate", () => {
    const adapter = openaiAdapterFactory.createStreamAdapter();

    const events = sseData<OpenAiFrame>(
      adapter.formatToolCallsSSE?.(REWRITTEN) ?? [],
    );

    expect(events).toHaveLength(1);
    const toolCalls = events[0].choices[0].delta.tool_calls;
    expect(toolCalls).toEqual([
      {
        index: 0,
        id: "call_0",
        type: "function",
        function: {
          name: "archestra__run_tool",
          arguments: REWRITTEN[0].arguments,
        },
      },
    ]);
    // A delta chunk must not also close the turn — formatEndSSE owns the
    // finish reason, and two of them desynchronize every OpenAI client.
    expect(events[0].choices[0].finish_reason).toBeNull();
  });

  test("indexes parallel calls in order", () => {
    const adapter = openaiAdapterFactory.createStreamAdapter();
    const calls = [
      { id: "a", name: "archestra__run_tool", arguments: '{"tool_name":"x"}' },
      { id: "b", name: "archestra__run_tool", arguments: '{"tool_name":"y"}' },
    ];

    const [event] = sseData<OpenAiFrame>(
      adapter.formatToolCallsSSE?.(calls) ?? [],
    );

    expect(
      event.choices[0].delta.tool_calls?.map((tc) => [tc.index, tc.id]),
    ).toEqual([
      [0, "a"],
      [1, "b"],
    ]);
  });

  test("streams the text of a chunk that also carries a call, and holds only the call", () => {
    // Forwarding the whole chunk would hand the client a fragment of the call
    // before the policies ruled on it, and a second copy of it once the batch
    // is re-emitted: a client accumulating by index would see it twice.
    const adapter = openaiAdapterFactory.createStreamAdapter();
    const result = adapter.processChunk({
      id: "chatcmpl-mixed",
      object: "chat.completion.chunk",
      created: 0,
      model: "gpt-x",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: "Delegating.",
            tool_calls: [
              {
                index: 0,
                id: "call_0",
                type: "function",
                function: { name: "task", arguments: '{"prompt":' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });

    const [forwarded] = sseData<OpenAiFrame>(
      result.sseData ? [result.sseData] : [],
    );
    expect(forwarded.choices[0].delta).toEqual({
      role: "assistant",
      content: "Delegating.",
    });
    expect(adapter.state.text).toBe("Delegating.");
    // The raw replay carries the call alone; the text is not sent twice.
    const held = sseData<OpenAiFrame>(adapter.getRawToolCallEvents());
    expect(held).toHaveLength(1);
    expect(held[0].choices[0].delta).not.toHaveProperty("content");
    expect(held[0].choices[0].delta.tool_calls?.[0]).toMatchObject({
      id: "call_0",
    });
    // A re-emitted batch is the only copy of the call the client receives.
    const reemitted = sseData<OpenAiFrame>(
      adapter.formatToolCallsSSE?.(REWRITTEN) ?? [],
    );
    expect(
      [forwarded, ...reemitted].flatMap(
        (frame) => frame.choices[0].delta.tool_calls ?? [],
      ),
    ).toHaveLength(1);
  });

  test("the reconstructed turn names the rewritten call, not the original", () => {
    const adapter = openaiAdapterFactory.createStreamAdapter();
    adapter.state.toolCalls.push({
      id: "call_0",
      name: "gh-developer-agent__pull_request_read",
      arguments: '{"pullNumber":7}',
    });
    adapter.formatToolCallsSSE?.(REWRITTEN);

    // The handler keeps state in step with what went out; toProviderResponse
    // reads that state, so the interaction log matches the client's view.
    adapter.state.toolCalls.splice(
      0,
      adapter.state.toolCalls.length,
      ...REWRITTEN,
    );

    const response = adapter.toProviderResponse();
    const [toolCall] = response.choices[0].message.tool_calls ?? [];
    expect(toolCall?.type === "function" && toolCall.function.name).toBe(
      "archestra__run_tool",
    );
  });

  test("uses a native question's signed wire id in streaming and non-streaming responses", () => {
    const nativeQuestion = [
      {
        id: "call_provider",
        wireId: "call_aq1_signed",
        name: "question",
        arguments: '{"questions":[]}',
      },
    ];
    const stream = openaiAdapterFactory.createStreamAdapter();
    const [event] = sseData<OpenAiFrame>(
      stream.formatToolCallsSSE?.(nativeQuestion) ?? [],
    );
    expect(event.choices[0].delta.tool_calls?.[0]).toMatchObject({
      id: "call_aq1_signed",
      function: { name: "question" },
    });

    const response = openaiAdapterFactory.createResponseAdapter({
      id: "chatcmpl_1",
      object: "chat.completion",
      created: 0,
      model: "model",
      choices: [
        {
          index: 0,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_provider",
                type: "function",
                function: { name: "archestra__ask_user", arguments: "{}" },
              },
            ],
          },
        },
      ],
    } as never);
    const rewritten = response.withRewrittenToolCalls?.(nativeQuestion);
    expect(rewritten?.choices[0].message.tool_calls?.[0]).toMatchObject({
      id: "call_aq1_signed",
      function: { name: "question" },
    });
  });
});

describe("Anthropic formatToolCallsSSE", () => {
  test("emits a well-formed tool_use block per call", () => {
    const adapter = anthropicAdapterFactory.createStreamAdapter();

    const frames = adapter.formatToolCallsSSE?.(REWRITTEN) ?? [];
    const events = sseData<AnthropicFrame>(frames);

    expect(events.map((e) => e.type)).toEqual([
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
    ]);
    expect(events[0].content_block).toMatchObject({
      type: "tool_use",
      id: "call_0",
      name: "archestra__run_tool",
    });
    // Anthropic streams tool input as partial_json the client concatenates;
    // one fragment carrying the whole object is the valid degenerate case.
    expect(JSON.parse(events[1].delta?.partial_json ?? "{}")).toEqual({
      tool_name: "gh-developer-agent__pull_request_read",
      tool_args: { pullNumber: 7 },
    });
  });

  test("gives each parallel call its own content-block index", () => {
    const adapter = anthropicAdapterFactory.createStreamAdapter();
    const calls = [
      { id: "a", name: "archestra__run_tool", arguments: "{}" },
      { id: "b", name: "archestra__run_tool", arguments: "{}" },
    ];

    const events = sseData<AnthropicFrame>(
      adapter.formatToolCallsSSE?.(calls) ?? [],
    );
    const indices = events.map((e) => e.index);

    expect(new Set(indices).size).toBe(2);
    expect(indices).toEqual([0, 0, 0, 1, 1, 1]);
  });

  test("releasing the calls lets the reconstructed turn name them", () => {
    const adapter = anthropicAdapterFactory.createStreamAdapter();
    adapter.state.toolCalls.push(...REWRITTEN);

    // Before release, toProviderResponse must not claim tool calls the client
    // never received; formatToolCallsSSE is that release.
    expect(adapter.toProviderResponse().content).toHaveLength(0);
    adapter.formatToolCallsSSE?.(REWRITTEN);
    expect(adapter.toProviderResponse().content).toContainEqual(
      expect.objectContaining({
        type: "tool_use",
        name: "archestra__run_tool",
      }),
    );
  });

  test("uses a native question's signed wire id in streaming and non-streaming responses", () => {
    const nativeQuestion = [
      {
        id: "toolu_provider",
        wireId: "toolu_aq1_signed",
        name: "AskUserQuestion",
        arguments: '{"questions":[]}',
      },
    ];
    const stream = anthropicAdapterFactory.createStreamAdapter();
    const events = sseData<AnthropicFrame>(
      stream.formatToolCallsSSE?.(nativeQuestion) ?? [],
    );
    expect(events[0].content_block).toMatchObject({
      id: "toolu_aq1_signed",
      name: "AskUserQuestion",
    });

    const response = anthropicAdapterFactory.createResponseAdapter({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "model",
      stop_reason: "tool_use",
      stop_sequence: null,
      content: [
        {
          type: "tool_use",
          id: "toolu_provider",
          name: "archestra__ask_user",
          input: {},
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    } as never);
    const rewritten = response.withRewrittenToolCalls?.(nativeQuestion);
    expect(rewritten?.content[0]).toMatchObject({
      type: "tool_use",
      id: "toolu_aq1_signed",
      name: "AskUserQuestion",
    });
  });
});

describe("ZhipuAI formatToolCallsSSE", () => {
  // OpenAI-chat-shaped wire; the same accumulate-by-index contract applies.
  test("emits one complete tool call the client can accumulate", () => {
    const adapter = zhipuaiAdapterFactory.createStreamAdapter();

    const events = sseData<OpenAiFrame>(
      adapter.formatToolCallsSSE?.(REWRITTEN) ?? [],
    );

    expect(events).toHaveLength(1);
    expect(events[0].choices[0].delta.tool_calls).toEqual([
      {
        index: 0,
        id: "call_0",
        type: "function",
        function: {
          name: "archestra__run_tool",
          arguments: REWRITTEN[0].arguments,
        },
      },
    ]);
    expect(events[0].choices[0].finish_reason).toBeNull();
  });
});
