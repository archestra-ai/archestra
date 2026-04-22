import { describe, expect, test } from "@/test";
import type { Bedrock, OpenAi } from "@/types";
import {
  converseResponseToOpenai,
  type OpenaiContext,
  openaiToConverse,
} from "./bedrock-openai-translator";

type OpenAiRequest = OpenAi.Types.ChatCompletionsRequest;

function req(overrides: Partial<OpenAiRequest> = {}): OpenAiRequest {
  return {
    model: "zai.glm-4.7",
    messages: [{ role: "user", content: "hello" }],
    ...overrides,
  } as OpenAiRequest;
}

describe("openaiToConverse — request envelope", () => {
  test("sets modelId from OpenAI model", () => {
    const { converseBody } = openaiToConverse(req());
    expect(converseBody.modelId).toBe("zai.glm-4.7");
  });

  test("sets _isStreaming=false when stream is absent", () => {
    const { converseBody } = openaiToConverse(req());
    expect(converseBody._isStreaming).toBe(false);
  });

  test("sets _isStreaming=true when stream=true", () => {
    const { converseBody } = openaiToConverse(req({ stream: true }));
    expect(converseBody._isStreaming).toBe(true);
  });

  test("context captures requested model and a chat completion id", () => {
    const { openaiContext } = openaiToConverse(req());
    expect(openaiContext.requestedModel).toBe("zai.glm-4.7");
    expect(openaiContext.chatcmplId).toMatch(/^chatcmpl-/);
    expect(openaiContext.createdUnix).toBeGreaterThan(1_000_000_000);
  });

  test("context includeUsageInStream defaults false and respects stream_options", () => {
    const a = openaiToConverse(req()).openaiContext;
    expect(a.includeUsageInStream).toBe(false);

    const b = openaiToConverse(
      // biome-ignore lint/suspicious/noExplicitAny: schema doesn't yet describe stream_options
      req({ stream: true, stream_options: { include_usage: true } } as any),
    ).openaiContext;
    expect(b.includeUsageInStream).toBe(true);
  });
});

describe("openaiToConverse — messages", () => {
  test("user string content → single text block under user role", () => {
    const { converseBody } = openaiToConverse(
      req({ messages: [{ role: "user", content: "hi there" }] }),
    );
    expect(converseBody.messages).toEqual([
      { role: "user", content: [{ text: "hi there" }] },
    ]);
  });

  test("system message extracted into top-level system array", () => {
    const { converseBody } = openaiToConverse(
      req({
        messages: [
          { role: "system", content: "you are helpful" },
          { role: "user", content: "hi" },
        ],
      }),
    );
    expect(converseBody.system).toEqual([{ text: "you are helpful" }]);
    expect(converseBody.messages).toEqual([
      { role: "user", content: [{ text: "hi" }] },
    ]);
  });

  test("developer role is treated as system", () => {
    const { converseBody } = openaiToConverse(
      req({
        messages: [
          { role: "developer", content: "dev instructions" },
          { role: "user", content: "hi" },
        ],
      }),
    );
    expect(converseBody.system).toEqual([{ text: "dev instructions" }]);
  });

  test("multiple system messages are concatenated into system array", () => {
    const { converseBody } = openaiToConverse(
      req({
        messages: [
          { role: "system", content: "a" },
          { role: "system", content: "b" },
          { role: "user", content: "hi" },
        ],
      }),
    );
    expect(converseBody.system).toEqual([{ text: "a" }, { text: "b" }]);
  });

  test("assistant text message → assistant role + text block", () => {
    const { converseBody } = openaiToConverse(
      req({
        messages: [
          { role: "user", content: "q" },
          { role: "assistant", content: "a" },
          { role: "user", content: "q2" },
        ],
      }),
    );
    expect(converseBody.messages).toEqual([
      { role: "user", content: [{ text: "q" }] },
      { role: "assistant", content: [{ text: "a" }] },
      { role: "user", content: [{ text: "q2" }] },
    ]);
  });

  test("assistant tool_calls → toolUse blocks", () => {
    const { converseBody } = openaiToConverse(
      req({
        messages: [
          { role: "user", content: "call a tool" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: {
                  name: "get_weather",
                  arguments: '{"city":"SF"}',
                },
              },
            ],
          },
        ],
      }),
    );
    expect(converseBody.messages?.[1]).toEqual({
      role: "assistant",
      content: [
        {
          toolUse: {
            toolUseId: "call_abc",
            name: "get_weather",
            input: { city: "SF" },
          },
        },
      ],
    });
  });

  test("assistant text + tool_calls → [text, toolUse] blocks in order", () => {
    const { converseBody } = openaiToConverse(
      req({
        messages: [
          { role: "user", content: "q" },
          {
            role: "assistant",
            content: "thinking...",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "f", arguments: "{}" },
              },
            ],
          },
        ],
      }),
    );
    expect(converseBody.messages?.[1]).toEqual({
      role: "assistant",
      content: [
        { text: "thinking..." },
        { toolUse: { toolUseId: "call_1", name: "f", input: {} } },
      ],
    });
  });

  test("tool role message → user role with toolResult block", () => {
    const { converseBody } = openaiToConverse(
      req({
        messages: [
          { role: "user", content: "q" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "f", arguments: "{}" },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call_1",
            content: "result body",
          },
        ],
      }),
    );
    expect(converseBody.messages?.[2]).toEqual({
      role: "user",
      content: [
        {
          toolResult: {
            toolUseId: "call_1",
            content: [{ text: "result body" }],
          },
        },
      ],
    });
  });

  test("consecutive tool results are merged under one user message", () => {
    const { converseBody } = openaiToConverse(
      req({
        messages: [
          { role: "user", content: "q" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "f", arguments: "{}" },
              },
              {
                id: "c2",
                type: "function",
                function: { name: "g", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "c1", content: "r1" },
          { role: "tool", tool_call_id: "c2", content: "r2" },
        ],
      }),
    );
    // After the assistant, exactly one user message carrying both toolResults
    expect(converseBody.messages?.length).toBe(3);
    expect(converseBody.messages?.[2]).toEqual({
      role: "user",
      content: [
        {
          toolResult: {
            toolUseId: "c1",
            content: [{ text: "r1" }],
          },
        },
        {
          toolResult: {
            toolUseId: "c2",
            content: [{ text: "r2" }],
          },
        },
      ],
    });
  });
});

describe("openaiToConverse — tools + tool_choice", () => {
  const tools = [
    {
      type: "function" as const,
      function: {
        name: "get_weather",
        description: "Get the weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    },
  ];

  test("tools[] → toolConfig.tools[].toolSpec", () => {
    const { converseBody } = openaiToConverse(
      req({ tools } as Partial<OpenAiRequest>),
    );
    expect(converseBody.toolConfig?.tools).toEqual([
      {
        toolSpec: {
          name: "get_weather",
          description: "Get the weather",
          inputSchema: { json: tools[0].function.parameters },
        },
      },
    ]);
  });

  test('tool_choice "auto" → {auto:{}}', () => {
    const { converseBody } = openaiToConverse(
      req({ tools, tool_choice: "auto" } as Partial<OpenAiRequest>),
    );
    expect(converseBody.toolConfig?.toolChoice).toEqual({ auto: {} });
  });

  test('tool_choice "required" → {any:{}}', () => {
    const { converseBody } = openaiToConverse(
      req({ tools, tool_choice: "required" } as Partial<OpenAiRequest>),
    );
    expect(converseBody.toolConfig?.toolChoice).toEqual({ any: {} });
  });

  test('tool_choice "none" → toolConfig omitted entirely', () => {
    const { converseBody } = openaiToConverse(
      req({ tools, tool_choice: "none" } as Partial<OpenAiRequest>),
    );
    expect(converseBody.toolConfig).toBeUndefined();
  });

  test("tool_choice {type:function, function:{name}} → {tool:{name}}", () => {
    const { converseBody } = openaiToConverse(
      req({
        tools,
        tool_choice: { type: "function", function: { name: "get_weather" } },
      } as Partial<OpenAiRequest>),
    );
    expect(converseBody.toolConfig?.toolChoice).toEqual({
      tool: { name: "get_weather" },
    });
  });
});

describe("openaiToConverse — inference config", () => {
  test("maps temperature, top_p, max_tokens, stop to inferenceConfig", () => {
    const { converseBody } = openaiToConverse(
      req({
        temperature: 0.7,
        max_tokens: 256,
        // biome-ignore lint/suspicious/noExplicitAny: schema currently narrow
      } as any),
    );
    expect(converseBody.inferenceConfig).toMatchObject({
      temperature: 0.7,
      maxTokens: 256,
    });
  });

  test("maps top_p → topP and stop → stopSequences (array)", () => {
    const { converseBody } = openaiToConverse(
      // biome-ignore lint/suspicious/noExplicitAny: extension params
      req({ top_p: 0.9, stop: ["END", "STOP"] } as any),
    );
    expect(converseBody.inferenceConfig?.topP).toBe(0.9);
    expect(converseBody.inferenceConfig?.stopSequences).toEqual([
      "END",
      "STOP",
    ]);
  });

  test("stop as a single string is wrapped in an array", () => {
    const { converseBody } = openaiToConverse(
      // biome-ignore lint/suspicious/noExplicitAny: extension params
      req({ stop: "END" } as any),
    );
    expect(converseBody.inferenceConfig?.stopSequences).toEqual(["END"]);
  });

  test("inferenceConfig is undefined when no sampling params are provided", () => {
    const { converseBody } = openaiToConverse(req());
    expect(converseBody.inferenceConfig).toBeUndefined();
  });
});

describe("openaiToConverse — images", () => {
  const png1x1 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

  test("data-URL image → {image:{format, source:{bytes}}}", () => {
    const { converseBody } = openaiToConverse(
      req({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${png1x1}` },
              },
            ],
          },
        ],
      }),
    );
    const content = converseBody.messages?.[0].content;
    expect(content?.[0]).toEqual({ text: "what is this?" });
    expect(content?.[1]).toEqual({
      image: { format: "png", source: { bytes: png1x1 } },
    });
  });

  test("non-data-URL image throws (with helpful message)", () => {
    expect(() =>
      openaiToConverse(
        req({
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image_url",
                  image_url: { url: "https://example.com/cat.png" },
                },
              ],
            },
          ],
        }),
      ),
    ).toThrow(/data[- ]?url/i);
  });
});

// =============================================================================
// Response translator
// =============================================================================

const ctx: OpenaiContext = {
  chatcmplId: "chatcmpl-test-id",
  createdUnix: 1_700_000_000,
  requestedModel: "zai.glm-4.7",
  includeUsageInStream: false,
};

function bedrockResp(
  overrides: Partial<Bedrock.Types.ConverseResponse> = {},
): Bedrock.Types.ConverseResponse {
  return {
    output: {
      message: {
        role: "assistant",
        content: [{ text: "hello" }],
      },
    },
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5 },
    ...overrides,
  };
}

describe("converseResponseToOpenai — envelope", () => {
  test("wraps in OpenAI chat.completion envelope using context", () => {
    const out = converseResponseToOpenai(bedrockResp(), ctx);
    expect(out.id).toBe("chatcmpl-test-id");
    expect(out.object).toBe("chat.completion");
    expect(out.created).toBe(1_700_000_000);
    expect(out.model).toBe("zai.glm-4.7");
  });

  test("single choice at index 0 with role=assistant", () => {
    const out = converseResponseToOpenai(bedrockResp(), ctx);
    expect(out.choices).toHaveLength(1);
    expect(out.choices[0].index).toBe(0);
    expect(out.choices[0].message.role).toBe("assistant");
  });
});

describe("converseResponseToOpenai — content", () => {
  test("text blocks concatenated into message.content", () => {
    const out = converseResponseToOpenai(
      bedrockResp({
        output: {
          message: {
            role: "assistant",
            content: [{ text: "hello " }, { text: "world" }],
          },
        },
      }),
      ctx,
    );
    expect(out.choices[0].message.content).toBe("hello world");
  });

  test("toolUse blocks → tool_calls with JSON-stringified arguments", () => {
    const out = converseResponseToOpenai(
      bedrockResp({
        output: {
          message: {
            role: "assistant",
            content: [
              {
                toolUse: {
                  toolUseId: "t_1",
                  name: "get_weather",
                  input: { city: "SF" },
                },
              },
            ],
          },
        },
        stopReason: "tool_use",
      }),
      ctx,
    );
    expect(out.choices[0].message.tool_calls).toEqual([
      {
        id: "t_1",
        type: "function",
        function: {
          name: "get_weather",
          arguments: '{"city":"SF"}',
        },
      },
    ]);
  });

  test("text + toolUse in one response → both content and tool_calls populated", () => {
    const out = converseResponseToOpenai(
      bedrockResp({
        output: {
          message: {
            role: "assistant",
            content: [
              { text: "let me check" },
              {
                toolUse: {
                  toolUseId: "t_1",
                  name: "f",
                  input: {},
                },
              },
            ],
          },
        },
        stopReason: "tool_use",
      }),
      ctx,
    );
    expect(out.choices[0].message.content).toBe("let me check");
    expect(out.choices[0].message.tool_calls?.[0].id).toBe("t_1");
  });
});

describe("converseResponseToOpenai — finish_reason mapping", () => {
  test.each([
    ["end_turn", "stop"],
    ["stop_sequence", "stop"],
    ["tool_use", "tool_calls"],
    ["max_tokens", "length"],
    ["guardrail_intervened", "content_filter"],
    ["content_filtered", "content_filter"],
  ] as const)("%s → %s", (stopReason, expected) => {
    const out = converseResponseToOpenai(
      bedrockResp({
        stopReason: stopReason as Bedrock.Types.ConverseResponse["stopReason"],
      }),
      ctx,
    );
    expect(out.choices[0].finish_reason).toBe(expected);
  });
});

describe("converseResponseToOpenai — usage", () => {
  test("maps inputTokens/outputTokens to prompt/completion tokens with total", () => {
    const out = converseResponseToOpenai(
      bedrockResp({ usage: { inputTokens: 42, outputTokens: 15 } }),
      ctx,
    );
    expect(out.usage).toEqual({
      prompt_tokens: 42,
      completion_tokens: 15,
      total_tokens: 57,
    });
  });
});
