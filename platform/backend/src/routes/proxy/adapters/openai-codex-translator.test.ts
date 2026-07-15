import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import { describe, expect, it } from "vitest";
import type { OpenAi } from "@/types";
import {
  buildCodexResponsesRequest,
  codexResponsesStreamToChatChunks,
  foldChatChunksToResponse,
} from "./openai-codex-translator";

type ChatCompletionsRequest = OpenAi.Types.ChatCompletionsRequest;

function req(
  overrides: Partial<ChatCompletionsRequest> = {},
): ChatCompletionsRequest {
  return {
    model: "gpt-5.5-codex",
    messages: [{ role: "user", content: "hi" }],
    ...overrides,
  } as ChatCompletionsRequest;
}

async function* streamOf(
  events: unknown[],
): AsyncGenerator<ResponseStreamEvent> {
  for (const event of events) {
    yield event as ResponseStreamEvent;
  }
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) {
    out.push(item);
  }
  return out;
}

describe("buildCodexResponsesRequest", () => {
  it("applies the mandatory Codex-backend transforms", () => {
    const body = buildCodexResponsesRequest(req()) as unknown as Record<
      string,
      unknown
    >;
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(typeof body.instructions).toBe("string");
    expect((body.instructions as string).length).toBeGreaterThan(0);
    expect(body.model).toBe("gpt-5.5-codex");
  });

  it("maps chat messages, tool calls, and tool results into responses input", () => {
    const body = buildCodexResponsesRequest(
      req({
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "call the tool" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: '{"q":"x"}' },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "result-text" },
        ],
      } as Partial<ChatCompletionsRequest>),
    ) as unknown as { input: Array<Record<string, unknown>> };

    // system → developer message
    expect(body.input[0]).toMatchObject({ type: "message", role: "developer" });
    // user → user message
    expect(body.input[1]).toMatchObject({ type: "message", role: "user" });
    // assistant tool call → function_call item
    expect(body.input[2]).toMatchObject({
      type: "function_call",
      call_id: "call_1",
      name: "lookup",
    });
    // tool result → function_call_output item
    expect(body.input[3]).toMatchObject({
      type: "function_call_output",
      call_id: "call_1",
      output: "result-text",
    });
  });

  it("maps chat function tools into responses function tools", () => {
    const body = buildCodexResponsesRequest(
      req({
        tools: [
          {
            type: "function",
            function: {
              name: "search",
              description: "search things",
              parameters: { type: "object" },
            },
          },
        ],
      } as Partial<ChatCompletionsRequest>),
    ) as unknown as {
      tools?: Array<Record<string, unknown>>;
      tool_choice?: string;
    };

    expect(body.tools?.[0]).toMatchObject({ type: "function", name: "search" });
    expect(body.tool_choice).toBe("auto");
  });

  it("maps a forced-function tool_choice to the responses object form", () => {
    const body = buildCodexResponsesRequest(
      req({
        tools: [
          {
            type: "function",
            function: { name: "search", parameters: { type: "object" } },
          },
        ],
        tool_choice: { type: "function", function: { name: "search" } },
      } as Partial<ChatCompletionsRequest>),
    ) as unknown as { tool_choice?: unknown };

    expect(body.tool_choice).toEqual({ type: "function", name: "search" });
  });

  it("preserves image parts as input_image instead of dropping them", () => {
    const body = buildCodexResponsesRequest(
      req({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,AAAA" },
              },
            ],
          },
        ],
      } as Partial<ChatCompletionsRequest>),
    ) as unknown as {
      input: Array<{ content: Array<Record<string, unknown>> }>;
    };

    const parts = body.input[0].content;
    expect(parts).toEqual([
      { type: "input_text", text: "what is this?" },
      { type: "input_image", image_url: "data:image/png;base64,AAAA" },
    ]);
  });
});

describe("codexResponsesStreamToChatChunks + fold", () => {
  const base = {
    model: "gpt-5.5-codex",
    completionId: "chatcmpl-test",
    createdUnixSeconds: 1_700_000_000,
  };

  it("translates text deltas and usage into chat chunks and a folded response", async () => {
    const events = [
      { type: "response.output_text.delta", delta: "Hello" },
      { type: "response.output_text.delta", delta: " world" },
      {
        type: "response.completed",
        response: {
          usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
        },
      },
    ];

    const chunks = await collect(
      codexResponsesStreamToChatChunks({ stream: streamOf(events), ...base }),
    );
    // Opening role chunk + 2 text deltas + closing chunk.
    expect(chunks[0].choices[0].delta).toMatchObject({ role: "assistant" });
    const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
    expect(text).toBe("Hello world");
    const last = chunks.at(-1);
    expect(last?.choices[0].finish_reason).toBe("stop");
    expect(last?.usage).toMatchObject({
      prompt_tokens: 10,
      completion_tokens: 3,
    });

    const response = await foldChatChunksToResponse({
      chunks: codexResponsesStreamToChatChunks({
        stream: streamOf(events),
        ...base,
      }),
      ...base,
    });
    expect(response.choices[0].message.content).toBe("Hello world");
    expect(response.choices[0].finish_reason).toBe("stop");
    expect(response.usage).toMatchObject({ prompt_tokens: 10 });
  });

  it("translates a streamed tool call into tool_calls chunks and finish_reason tool_calls", async () => {
    const events = [
      {
        type: "response.output_item.added",
        item: {
          id: "fc_1",
          call_id: "call_abc",
          type: "function_call",
          name: "get_weather",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: '{"city":',
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: '"paris"}',
      },
      { type: "response.completed", response: { usage: null } },
    ];

    const response = await foldChatChunksToResponse({
      chunks: codexResponsesStreamToChatChunks({
        stream: streamOf(events),
        ...base,
      }),
      ...base,
    });

    expect(response.choices[0].finish_reason).toBe("tool_calls");
    const toolCall = response.choices[0].message.tool_calls?.[0];
    expect(toolCall).toMatchObject({
      id: "call_abc",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"paris"}' },
    });
  });

  it("throws on response.failed instead of masking it as a successful turn", async () => {
    const events = [
      {
        type: "response.failed",
        response: { error: { message: "server error" } },
      },
    ];
    await expect(
      collect(
        codexResponsesStreamToChatChunks({ stream: streamOf(events), ...base }),
      ),
    ).rejects.toMatchObject({ statusCode: 502 });
  });

  it("carries usage and finish_reason on response.incomplete (max tokens)", async () => {
    const events = [
      { type: "response.output_text.delta", delta: "partial" },
      {
        type: "response.incomplete",
        response: {
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
          incomplete_details: { reason: "max_output_tokens" },
        },
      },
    ];
    const chunks = await collect(
      codexResponsesStreamToChatChunks({ stream: streamOf(events), ...base }),
    );
    const last = chunks.at(-1);
    expect(last?.choices[0].finish_reason).toBe("length");
    expect(last?.usage).toMatchObject({
      prompt_tokens: 5,
      completion_tokens: 2,
    });
  });
});
