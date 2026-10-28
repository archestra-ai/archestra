import { describe, expect, test } from "vitest";
import type { Anthropic, OpenAi } from "@/types";
import {
  anthropicToOpenai,
  createOpenaiToAnthropicStreamTranslator,
  openaiResponseToAnthropic,
} from "./openai-anthropic-translator";

type AnthropicRequest = Anthropic.Types.MessagesRequest;

function req(overrides: Record<string, unknown> = {}): AnthropicRequest {
  return {
    model: "glm-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  } as AnthropicRequest;
}

const ctx = { messageId: "msg_1", requestedModel: "glm-5" };

describe("anthropicToOpenai", () => {
  test("carries the system prompt, sampling and stop sequences", () => {
    const { openaiBody } = anthropicToOpenai(
      req({
        system: [
          { type: "text", text: "Be brief." },
          { type: "text", text: "Use English." },
        ],
        temperature: 0.2,
        top_p: 0.9,
        stop_sequences: ["END"],
        stream: true,
      }),
    );
    expect(openaiBody).toEqual({
      model: "glm-5",
      max_tokens: 1024,
      stream: true,
      temperature: 0.2,
      top_p: 0.9,
      stop: ["END"],
      messages: [
        { role: "system", content: "Be brief.\n\nUse English." },
        { role: "user", content: "hello" },
      ],
    });
  });

  test("turns a tool call and its result into OpenAI tool messages", () => {
    const { openaiBody } = anthropicToOpenai(
      req({
        messages: [
          { role: "user", content: "weather?" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hm", signature: "sig" },
              { type: "text", text: "Checking." },
              {
                type: "tool_use",
                id: "toolu_1",
                name: "get_weather",
                input: { city: "Paris" },
              },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "toolu_1", content: "sunny" },
              { type: "text", text: "and tomorrow?" },
            ],
          },
        ],
        tools: [
          {
            name: "get_weather",
            description: "Weather for a city",
            input_schema: { type: "object", properties: {} },
          },
          { type: "web_search_20250305", name: "web_search" },
        ],
        tool_choice: { type: "any" },
      }),
    );
    expect(openaiBody.messages).toEqual([
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: "Checking.",
        tool_calls: [
          {
            id: "toolu_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "toolu_1", content: "sunny" },
      { role: "user", content: "and tomorrow?" },
    ]);
    expect(openaiBody.tools).toEqual([
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Weather for a city",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
    expect(openaiBody.tool_choice).toBe("required");
  });

  test("marks a failed tool result and forwards images", () => {
    const { openaiBody } = anthropicToOpenai(
      req({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                is_error: true,
                content: [{ type: "text", text: "timeout" }],
              },
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: "AA" },
              },
            ],
          },
        ],
      }),
    );
    expect(openaiBody.messages).toEqual([
      { role: "tool", tool_call_id: "toolu_1", content: "Error: timeout" },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AA" },
          },
        ],
      },
    ]);
  });
});

describe("openaiResponseToAnthropic", () => {
  test("answers with text, tool calls, the stop reason and cache-aware usage", () => {
    const response = openaiResponseToAnthropic(
      {
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 1,
        model: "glm-5",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: "Checking.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: '{"city":"Paris"}',
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 60 },
        },
      } as unknown as OpenAi.Types.ChatCompletionsResponse,
      ctx,
    );
    expect(response).toEqual({
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "glm-5",
      content: [
        { type: "text", text: "Checking." },
        {
          type: "tool_use",
          id: "call_1",
          name: "get_weather",
          input: { city: "Paris" },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 40,
        output_tokens: 20,
        cache_read_input_tokens: 60,
      },
    });
  });
});

describe("createOpenaiToAnthropicStreamTranslator", () => {
  const chunk = (delta: unknown, extra: Record<string, unknown> = {}) =>
    ({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "glm-5",
      choices: [{ index: 0, delta, finish_reason: null }],
      ...extra,
    }) as unknown as OpenAi.Types.ChatCompletionChunk;

  test("streams text then a tool call as Anthropic events", () => {
    const translator = createOpenaiToAnthropicStreamTranslator(ctx);
    const events = [
      ...translator.translate(chunk({ role: "assistant", content: "" })),
      ...translator.translate(chunk({ content: "Hi" })),
      ...translator.translate(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"ci' },
            },
          ],
        }),
      ),
      ...translator.translate(
        chunk({
          tool_calls: [{ index: 0, function: { arguments: 'ty":1}' } }],
        }),
      ),
      ...translator.translate({
        ...chunk({}),
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      } as unknown as OpenAi.Types.ChatCompletionChunk),
      ...translator.translate({
        ...chunk({}),
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      } as unknown as OpenAi.Types.ChatCompletionChunk),
      ...translator.finish(),
    ];
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[4]).toEqual({
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "call_1",
        name: "get_weather",
        input: {},
      },
    });
    expect(events[8]).toEqual({
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  });

  test("refuses to finish a stream that was cut off", () => {
    const translator = createOpenaiToAnthropicStreamTranslator(ctx);
    translator.translate(chunk({ content: "Hal" }));
    expect(() => translator.finish()).toThrow(/ended before it finished/);
  });
});
