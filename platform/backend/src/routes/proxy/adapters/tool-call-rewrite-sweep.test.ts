/**
 * `formatToolCallsSSE` / `withRewrittenToolCalls` across every remaining wire
 * format — the adapter halves of the proxy's dispatch-mode repair (see
 * `planDispatchModeToolCallRewrites`). tool-call-rewrite.test.ts covers the
 * OpenAI chat, Anthropic and ZhipuAI shapes; this file covers the rest.
 *
 * Each case pins the frame a real client of that wire format needs in order to
 * accumulate the rewritten call — because a malformed stream here fails
 * silently (the client drops it or reconstructs the wrong turn) rather than
 * throwing anywhere a test would notice.
 */

import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { describe, expect, test } from "@/test";
import type { Anthropic, Bedrock, Gemini, OpenAi } from "@/types";
import { anthropicAdapterFactory } from "./anthropic";
import { azureResponsesAdapterFactory } from "./azure-responses";
import { bedrockAdapterFactory } from "./bedrock";
import { makeBedrockOpenaiAdapterFactory } from "./bedrock-openai";
import { cohereAdapterFactory } from "./cohere";
import { geminiAdapterFactory } from "./gemini";
import { minimaxAdapterFactory } from "./minimax";
import { ollamaNativeAdapterFactory } from "./ollama-native";
import { openaiAdapterFactory } from "./openai";
import { openAiResponsesAdapterFactory } from "./openai-responses";
import { makeResponsesFromChatAdapterFactory } from "./openai-responses-from-chat";

const eventStreamCodec = new EventStreamCodec(toUtf8, fromUtf8);

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
const REWRITTEN_ARGS_OBJECT = JSON.parse(REWRITTEN[0].arguments);

/** `data: {...}` payloads out of SSE frames (strings or UTF-8 bytes). */
function sseData<TFrame>(frames: (string | Uint8Array)[]): TFrame[] {
  return frames
    .map((frame) =>
      typeof frame === "string" ? frame : new TextDecoder().decode(frame),
    )
    .flatMap((frame) => frame.split("\n"))
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length))
    .filter((payload) => payload !== "[DONE]")
    .map((payload) => JSON.parse(payload) as TFrame);
}

/** One NDJSON line per element. */
function ndjson<TFrame>(frames: (string | Uint8Array)[]): TFrame[] {
  return frames
    .map(String)
    .flatMap((frame) => frame.split("\n"))
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TFrame);
}

type ResponsesFrame = {
  type: string;
  output_index?: number;
  item?: { type: string; call_id?: string; name?: string; arguments?: string };
  delta?: string;
  name?: string;
  arguments?: string;
  response?: {
    output: Array<{ type: string; name?: string; call_id?: string }>;
  };
};

// ---------------------------------------------------------------------------
// Responses API — native OpenAI and Azure (same code path), plus the
// Responses-from-chat translator.
// ---------------------------------------------------------------------------
describe.each([
  ["OpenAI Responses", openAiResponsesAdapterFactory],
  ["Azure Responses", azureResponsesAdapterFactory],
] as const)("%s formatToolCallsSSE", (_label, factory) => {
  test("emits the four call frames and a trailing completed envelope naming the rewrite", () => {
    const adapter = factory.createStreamAdapter();
    // What the upstream already streamed: a completed envelope naming the
    // ORIGINAL call. The client keeps the last completed envelope it sees.
    adapter.processChunk({
      type: "response.completed",
      sequence_number: 1,
      response: {
        id: "resp_1",
        object: "response",
        created_at: 0,
        model: "gpt-x",
        status: "completed",
        output: [
          {
            id: "fc_orig",
            call_id: "call_0",
            type: "function_call",
            name: "gh-developer-agent__pull_request_read",
            arguments: '{"pullNumber":7}',
            status: "completed",
          },
        ],
      },
    } as never);

    const events = sseData<ResponsesFrame>(
      adapter.formatToolCallsSSE?.(REWRITTEN) ?? [],
    );

    expect(events.map((e) => e.type)).toEqual([
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events[0].item).toMatchObject({
      type: "function_call",
      call_id: "call_0",
      name: "archestra__run_tool",
    });
    expect(events[1].delta).toBe(REWRITTEN[0].arguments);
    expect(events[3].item?.arguments).toBe(REWRITTEN[0].arguments);

    // The envelope the client reconstructs from must name the rewrite — and
    // keep the call id, which the client's tool result is correlated by.
    const completed = events[4].response?.output ?? [];
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      type: "function_call",
      call_id: "call_0",
      name: "archestra__run_tool",
    });

    // And the persisted turn matches the client's view.
    const persisted = adapter.toProviderResponse() as {
      output: Array<{ name?: string }>;
    };
    expect(persisted.output[0].name).toBe("archestra__run_tool");
  });

  test("non-streaming: rewrites the function_call item in place by call_id", () => {
    const adapter = factory.createResponseAdapter({
      id: "resp_1",
      object: "response",
      created_at: 0,
      model: "gpt-x",
      status: "completed",
      output: [
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "On it.", annotations: [] }],
        },
        {
          id: "fc_orig",
          call_id: "call_0",
          type: "function_call",
          name: "gh-developer-agent__pull_request_read",
          arguments: '{"pullNumber":7}',
          status: "completed",
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    } as never);

    const rewritten = adapter.withRewrittenToolCalls?.(REWRITTEN) as {
      output: Array<{ type: string; name?: string; call_id?: string }>;
    };

    expect(rewritten.output.map((item) => item.type)).toEqual([
      "message",
      "function_call",
    ]);
    expect(rewritten.output[1]).toMatchObject({
      call_id: "call_0",
      name: "archestra__run_tool",
    });
  });
});

describe("Responses-from-chat translator formatToolCallsSSE", () => {
  const ctx = { responseId: "resp_t", createdUnix: 0, requestedModel: "gpt-x" };

  test("emits the call frames then a completed envelope naming the rewrite", () => {
    const factory = makeResponsesFromChatAdapterFactory(
      openaiAdapterFactory,
      ctx,
    );
    const adapter = factory.createStreamAdapter();

    const events = sseData<ResponsesFrame>(
      adapter.formatToolCallsSSE?.(REWRITTEN) ?? [],
    );

    expect(events.map((e) => e.type)).toEqual([
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
    // Text owns output index 0 on this surface; calls start at 1.
    expect(events[0].output_index).toBe(1);
    expect(events[4].response?.output).toContainEqual(
      expect.objectContaining({
        type: "function_call",
        call_id: "call_0",
        name: "archestra__run_tool",
      }),
    );
  });

  test("non-streaming: translates the inner rewrite and logs the inner shape", () => {
    const factory = makeResponsesFromChatAdapterFactory(
      openaiAdapterFactory,
      ctx,
    );
    const chat: OpenAi.Types.ChatCompletionsResponse = {
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 0,
      model: "gpt-x",
      choices: [
        {
          index: 0,
          logprobs: null,
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: "call_0",
                type: "function",
                function: {
                  name: "gh-developer-agent__pull_request_read",
                  arguments: '{"pullNumber":7}',
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const adapter = factory.createResponseAdapter(chat);

    const wire = adapter.withRewrittenToolCalls?.(REWRITTEN) as unknown as {
      output: Array<{ type: string; name?: string }>;
    };
    expect(wire.output).toContainEqual(
      expect.objectContaining({
        type: "function_call",
        name: "archestra__run_tool",
      }),
    );

    // The interaction log stores the inner (chat) shape — and it must be the
    // rewritten one, not the original the provider sent.
    const logged = adapter.getLoggedResponse?.() as typeof chat;
    const [loggedCall] = logged.choices[0].message.tool_calls ?? [];
    expect(loggedCall?.type === "function" && loggedCall.function.name).toBe(
      "archestra__run_tool",
    );
  });
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------
describe("Gemini formatToolCallsSSE / withRewrittenToolCalls", () => {
  type GeminiFrame = {
    candidates: Array<{
      content: {
        parts: Array<{ functionCall?: { name: string; args: unknown } }>;
      };
      finishReason?: string;
    }>;
  };

  test("emits one chunk with a functionCall part per call and no finishReason", () => {
    const adapter = geminiAdapterFactory.createStreamAdapter();
    const [event] = sseData<GeminiFrame>(
      adapter.formatToolCallsSSE?.(REWRITTEN) ?? [],
    );

    expect(event.candidates[0].content.parts).toEqual([
      {
        functionCall: {
          id: "call_0",
          name: "archestra__run_tool",
          args: REWRITTEN_ARGS_OBJECT,
        },
      },
    ]);
    expect(event.candidates[0].finishReason).toBeUndefined();
  });

  test("non-streaming: rewrites functionCall parts positionally", () => {
    const adapter = geminiAdapterFactory.createResponseAdapter({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { text: "On it." },
              {
                functionCall: {
                  name: "gh-developer-agent__pull_request_read",
                  args: { pullNumber: 7 },
                },
              },
            ],
          },
          finishReason: "STOP",
          index: 0,
        },
      ],
    } as unknown as Gemini.Types.GenerateContentResponse);

    const rewritten = adapter.withRewrittenToolCalls?.(
      REWRITTEN,
    ) as unknown as GeminiFrame;
    const parts = rewritten.candidates[0].content.parts;
    expect(parts[0]).toEqual({ text: "On it." });
    expect(parts[1].functionCall).toMatchObject({
      name: "archestra__run_tool",
      args: REWRITTEN_ARGS_OBJECT,
    });
  });
});

// ---------------------------------------------------------------------------
// Cohere v2
// ---------------------------------------------------------------------------
describe("Cohere formatToolCallsSSE / withRewrittenToolCalls", () => {
  type CohereFrame = {
    type: string;
    delta?: {
      message?: {
        tool_calls?: {
          id?: string;
          function?: { name?: string; arguments?: string };
        };
      };
    };
  };

  test("emits start/delta/end in the shape @ai-sdk/cohere accumulates", () => {
    const adapter = cohereAdapterFactory.createStreamAdapter();
    const events = sseData<CohereFrame>(
      adapter.formatToolCallsSSE?.(REWRITTEN) ?? [],
    );

    expect(events.map((e) => e.type)).toEqual([
      "tool-call-start",
      "tool-call-delta",
      "tool-call-end",
    ]);
    expect(events[0].delta?.message?.tool_calls).toMatchObject({
      id: "call_0",
      function: { name: "archestra__run_tool" },
    });
    expect(events[1].delta?.message?.tool_calls?.function?.arguments).toBe(
      REWRITTEN[0].arguments,
    );
  });

  test("non-streaming: rewrites message.tool_calls positionally", () => {
    const adapter = cohereAdapterFactory.createResponseAdapter({
      id: "c1",
      finish_reason: "TOOL_CALL",
      message: {
        role: "assistant",
        tool_calls: [
          {
            id: "call_0",
            type: "function",
            function: {
              name: "gh-developer-agent__pull_request_read",
              arguments: '{"pullNumber":7}',
            },
          },
        ],
      },
    } as never);
    const rewritten = adapter.withRewrittenToolCalls?.(REWRITTEN) as {
      message: {
        tool_calls: Array<{ id: string; function: { name: string } }>;
      };
    };
    expect(rewritten.message.tool_calls[0]).toMatchObject({
      id: "call_0",
      function: { name: "archestra__run_tool" },
    });
  });
});

// ---------------------------------------------------------------------------
// Ollama native (NDJSON)
// ---------------------------------------------------------------------------
describe("Ollama native formatToolCallsSSE / withRewrittenToolCalls", () => {
  type OllamaFrame = {
    done: boolean;
    message: {
      tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
    };
  };

  test("emits one non-final line with the calls whole", () => {
    const adapter = ollamaNativeAdapterFactory.createStreamAdapter();
    const [line] = ndjson<OllamaFrame>(
      adapter.formatToolCallsSSE?.(REWRITTEN) ?? [],
    );

    expect(line.done).toBe(false);
    expect(line.message.tool_calls).toEqual([
      {
        id: "call_0",
        function: {
          name: "archestra__run_tool",
          arguments: REWRITTEN_ARGS_OBJECT,
        },
      },
    ]);
  });

  test("non-streaming: rewrites message.tool_calls positionally", () => {
    const adapter = ollamaNativeAdapterFactory.createResponseAdapter({
      model: "llama",
      created_at: "0",
      done: true,
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            function: {
              name: "gh-developer-agent__pull_request_read",
              arguments: { pullNumber: 7 },
            },
          },
        ],
      },
    } as never);
    const rewritten = adapter.withRewrittenToolCalls?.(
      REWRITTEN,
    ) as unknown as OllamaFrame;
    expect(rewritten.message.tool_calls?.[0].function).toEqual({
      name: "archestra__run_tool",
      arguments: REWRITTEN_ARGS_OBJECT,
    });
  });
});

// ---------------------------------------------------------------------------
// Minimax (OpenAI-chat-shaped)
// ---------------------------------------------------------------------------
describe("Minimax formatToolCallsSSE", () => {
  test("emits one complete tool_calls delta chunk", () => {
    const adapter = minimaxAdapterFactory.createStreamAdapter();
    const [event] = sseData<{
      choices: Array<{
        delta: {
          tool_calls?: Array<{ id: string; function: { name: string } }>;
        };
        finish_reason: string | null;
      }>;
    }>(adapter.formatToolCallsSSE?.(REWRITTEN) ?? []);

    expect(event.choices[0].delta.tool_calls?.[0]).toMatchObject({
      id: "call_0",
      function: { name: "archestra__run_tool" },
    });
    expect(event.choices[0].finish_reason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Anthropic — non-streaming half (streaming is in tool-call-rewrite.test.ts)
// ---------------------------------------------------------------------------
describe("Anthropic withRewrittenToolCalls", () => {
  test("rewrites tool_use blocks positionally, keeping ids and text", () => {
    const adapter = anthropicAdapterFactory.createResponseAdapter({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude",
      stop_reason: "tool_use",
      stop_sequence: null,
      content: [
        { type: "text", text: "On it." },
        {
          type: "tool_use",
          id: "call_0",
          name: "gh-developer-agent__pull_request_read",
          input: { pullNumber: 7 },
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    } as unknown as Anthropic.Types.MessagesResponse);

    const rewritten = adapter.withRewrittenToolCalls?.(REWRITTEN) as {
      content: Array<{
        type: string;
        id?: string;
        name?: string;
        input?: unknown;
      }>;
    };
    expect(rewritten.content[0]).toEqual({ type: "text", text: "On it." });
    expect(rewritten.content[1]).toMatchObject({
      type: "tool_use",
      id: "call_0",
      name: "archestra__run_tool",
      input: REWRITTEN_ARGS_OBJECT,
    });
  });
});

// ---------------------------------------------------------------------------
// Bedrock — Converse binary event stream, and the Converse→OpenAI translator
// ---------------------------------------------------------------------------
function decodeBedrockFrames(frames: (string | Uint8Array)[]) {
  return frames.map((frame) => {
    const decoded = eventStreamCodec.decode(frame as Uint8Array);
    const eventType = (decoded.headers[":event-type"] as { value: string })
      .value;
    const bodyText =
      typeof decoded.body === "string" ? decoded.body : toUtf8(decoded.body);
    return { eventType, body: JSON.parse(bodyText) as Record<string, unknown> };
  });
}

describe("Bedrock formatToolCallsSSE / withRewrittenToolCalls", () => {
  test("emits a tool_use block per call, reusing the held block index, then the terminal events", () => {
    const adapter = bedrockAdapterFactory.createStreamAdapter();
    // Live turn: a held tool_use block at contentBlockIndex 1 (index 0 was
    // text), then the terminal events the adapter buffers behind the gate.
    adapter.processChunk({
      contentBlockStart: {
        contentBlockIndex: 1,
        start: {
          toolUse: {
            toolUseId: "call_0",
            name: "gh-developer-agent__pull_request_read",
          },
        },
      },
    } as never);
    adapter.processChunk({
      contentBlockDelta: {
        contentBlockIndex: 1,
        delta: { toolUse: { input: '{"pullNumber":7}' } },
      },
    } as never);
    adapter.processChunk({
      contentBlockStop: { contentBlockIndex: 1 },
    } as never);
    adapter.processChunk({ messageStop: { stopReason: "tool_use" } } as never);
    adapter.processChunk({
      metadata: { usage: { inputTokens: 1, outputTokens: 1 } },
    } as never);

    const frames = decodeBedrockFrames(
      adapter.formatToolCallsSSE?.(REWRITTEN) ?? [],
    );

    expect(frames.map((f) => f.eventType)).toEqual([
      "contentBlockStart",
      "contentBlockDelta",
      "contentBlockStop",
      "messageStop",
      "metadata",
    ]);
    // toMatchObject: the encoder adds Bedrock's `p` padding field to every
    // event, exactly as it does for the live and refusal frames.
    expect(frames[0].body).toMatchObject({
      contentBlockIndex: 1,
      start: { toolUse: { toolUseId: "call_0", name: "archestra__run_tool" } },
    });
    expect(frames[1].body).toMatchObject({
      contentBlockIndex: 1,
      delta: { toolUse: { input: REWRITTEN[0].arguments } },
    });
  });

  test("non-streaming: rewrites toolUse blocks positionally", () => {
    const adapter = bedrockAdapterFactory.createResponseAdapter({
      output: {
        message: {
          role: "assistant",
          content: [
            { text: "On it." },
            {
              toolUse: {
                toolUseId: "call_0",
                name: "gh-developer-agent__pull_request_read",
                input: { pullNumber: 7 },
              },
            },
          ],
        },
      },
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as unknown as Bedrock.Types.ConverseResponse);

    const rewritten = adapter.withRewrittenToolCalls?.(REWRITTEN) as {
      output: {
        message: {
          content: Array<{
            text?: string;
            toolUse?: { toolUseId: string; name: string; input: unknown };
          }>;
        };
      };
    };
    const content = rewritten.output.message.content;
    expect(content[0]).toEqual({ text: "On it." });
    expect(content[1].toolUse).toEqual({
      toolUseId: "call_0",
      name: "archestra__run_tool",
      input: REWRITTEN_ARGS_OBJECT,
    });
  });
});

describe("Bedrock→OpenAI translator formatToolCallsSSE / withRewrittenToolCalls", () => {
  const ctx = {
    chatcmplId: "chatcmpl-b",
    createdUnix: 0,
    requestedModel: "m",
    includeUsageInStream: false,
  };

  test("emits an OpenAI tool_calls delta and holds the finish reason", () => {
    const factory = makeBedrockOpenaiAdapterFactory(ctx);
    const adapter = factory.createStreamAdapter(undefined);
    const events = sseData<{
      choices: Array<{
        delta: {
          role?: string;
          tool_calls?: Array<{ id: string; function: { name: string } }>;
        };
        finish_reason: string | null;
      }>;
    }>(adapter.formatToolCallsSSE?.(REWRITTEN) ?? []);

    const toolCallChunk = events.find((e) => e.choices[0].delta.tool_calls);
    expect(toolCallChunk?.choices[0].delta.tool_calls?.[0]).toMatchObject({
      id: "call_0",
      function: { name: "archestra__run_tool" },
    });
    for (const event of events) {
      expect(event.choices[0].finish_reason).toBeNull();
    }
  });

  test("non-streaming: client gets OpenAI shape, log gets rewritten Converse shape", () => {
    const factory = makeBedrockOpenaiAdapterFactory(ctx);
    const adapter = factory.createResponseAdapter({
      output: {
        message: {
          role: "assistant",
          content: [
            {
              toolUse: {
                toolUseId: "call_0",
                name: "gh-developer-agent__pull_request_read",
                input: { pullNumber: 7 },
              },
            },
          ],
        },
      },
      stopReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    } as unknown as Bedrock.Types.ConverseResponse);

    const wire = adapter.withRewrittenToolCalls?.(
      REWRITTEN,
    ) as unknown as OpenAi.Types.ChatCompletionsResponse;
    const [wireCall] = wire.choices[0].message.tool_calls ?? [];
    expect(wireCall?.type === "function" && wireCall.function.name).toBe(
      "archestra__run_tool",
    );

    const logged = adapter.getLoggedResponse?.() as unknown as {
      output: { message: { content: Array<{ toolUse?: { name: string } }> } };
    };
    expect(logged.output.message.content[0].toolUse?.name).toBe(
      "archestra__run_tool",
    );
  });
});
