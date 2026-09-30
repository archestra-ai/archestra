import { describe, expect, test } from "vitest";
import type { OpenAi } from "@/types";
import {
  converseResponseToOpenai,
  createConverseToOpenaiSseEncoder,
  openaiToConverse,
} from "./bedrock-openai-translator";
import {
  chatCompletionToResponses,
  responsesToOpenaiChat,
} from "./openai-responses-translator";
import { fromResponsesUsage, type toResponsesUsage } from "./responses-usage";

const model = "us.anthropic.claude-sonnet-4-6";
const marker = { type: "ephemeral" };
const checkpoint = { cachePoint: { type: "default" } };
const ctx = {
  chatcmplId: "chatcmpl_test",
  createdUnix: 1,
  requestedModel: model,
  includeUsageInStream: true,
};
function translate(
  messages: unknown[],
  overrides: Record<string, unknown> = {},
) {
  return openaiToConverse({
    model,
    messages,
    ...overrides,
  } as OpenAi.Types.ChatCompletionsRequest).converseBody;
}

describe("explicit Bedrock caller caching", () => {
  test("preserves mixed Responses parts and marker boundaries across both translations", () => {
    const input = [
      {
        role: "user",
        content: [
          { type: "input_text", text: "start", cache_control: marker },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
          {
            type: "input_file",
            file_data: "data:application/pdf;base64,cGRm",
            filename: "ignored.pdf",
          },
          {
            type: "input_file",
            file_data: "data:application/json;base64,e30=",
            cache_control: marker,
          },
          { type: "input_text", text: "end" },
        ],
      },
    ];
    const { chatBody } = responsesToOpenaiChat(
      { model, input } as unknown as OpenAi.Types.ResponsesRequest,
      { preserveContentParts: true },
    );
    expect(
      openaiToConverse(chatBody).converseBody.messages?.[0].content,
    ).toEqual([
      { text: "start" },
      checkpoint,
      { image: { format: "png", source: { bytes: "aGVsbG8=" } } },
      {
        document: {
          format: "pdf",
          name: "document",
          source: { bytes: "cGRm" },
        },
      },
      {
        document: {
          format: "txt",
          name: "document",
          source: { bytes: "e30=" },
        },
      },
      checkpoint,
      { text: "end" },
    ]);
  });

  test.each([
    { input: [{ type: "reasoning", summary: [] }] },
    { input: [{ role: "user", content: [null] }] },
    { input: "question", tools: [{ type: "web_search" }] },
  ])("rejects unsupported Responses input instead of dropping it: %j", (body) => {
    expect(() =>
      responsesToOpenaiChat(
        { model, ...body } as unknown as OpenAi.Types.ResponsesRequest,
        { preserveContentParts: true },
      ),
    ).toThrow(/Bedrock Responses/);
  });

  test("canonical base64 file bytes use the supported filename extension", () => {
    expect(
      translate([
        {
          role: "user",
          content: [
            {
              type: "file",
              file: { file_data: "e30=", filename: "reference.json" },
            },
          ],
        },
      ]).messages?.[0].content[1],
    ).toEqual({
      document: { format: "txt", name: "document", source: { bytes: "e30=" } },
    });
  });

  test("tool-result part markers never widen the caller's requested boundary", () => {
    expect(() =>
      translate([
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [
            { type: "text", text: "first", cache_control: marker },
            { type: "text", text: "second" },
          ],
        },
      ]),
    ).toThrow(/complete tool result/);
    expect(
      translate([
        {
          role: "tool",
          tool_call_id: "call_1",
          content: [{ type: "text", text: "result", cache_control: marker }],
        },
      ]).messages?.[0].content,
    ).toEqual([
      { toolResult: { toolUseId: "call_1", content: [{ text: "result" }] } },
      checkpoint,
    ]);
  });

  test("document-only input gains companion text before the document and checkpoint", () => {
    expect(
      translate([
        {
          role: "user",
          content: [
            {
              type: "file",
              file: { file_data: "data:application/pdf;base64,cGRm" },
              cache_control: marker,
            },
          ],
        },
      ]).messages?.[0].content,
    ).toEqual([
      { text: "Please review the attached document." },
      {
        document: {
          format: "pdf",
          name: "document",
          source: { bytes: "cGRm" },
        },
      },
      checkpoint,
    ]);
  });

  test.each([
    { file_id: "file_1" },
    { file_url: "https://example.test/file.pdf" },
    { file_data: "data:application/zip;base64,e30=" },
    {},
  ])("rejects unresolved or unsupported file %j", (file) => {
    expect(() =>
      translate([{ role: "user", content: [{ type: "file", file }] }]),
    ).toThrow(/Bedrock/);
  });

  test("places system, assistant and growing tool-result markers without changing tool IDs", () => {
    const request = translate([
      {
        role: "system",
        content: [
          {
            type: "text",
            text: "stable",
            cache_control: { ...marker, ttl: "1h" },
          },
        ],
      },
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: [{ type: "text", text: "checking" }],
        tool_calls: [
          {
            type: "function",
            id: "call_1",
            function: { name: "read", arguments: "{}" },
          },
        ],
        cache_control: marker,
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "result".repeat(1000),
        cache_control: marker,
      },
      {
        role: "tool",
        tool_call_id: "call_2",
        content: "second result",
        cache_control: marker,
      },
    ]);
    expect(request.system).toEqual([
      { text: "stable" },
      { cachePoint: { type: "default", ttl: "1h" } },
    ]);
    expect(request.messages?.[1].content).toEqual([
      { text: "checking" },
      { toolUse: { toolUseId: "call_1", name: "read", input: {} } },
      checkpoint,
    ]);
    expect(request.messages?.[2].content).toEqual([
      {
        toolResult: {
          toolUseId: "call_1",
          content: [{ text: "result".repeat(1000) }],
        },
      },
      checkpoint,
      {
        toolResult: {
          toolUseId: "call_2",
          content: [{ text: "second result" }],
        },
      },
      checkpoint,
    ]);
  });

  test.each([
    0, 1, 2, 3, 4, 5,
  ])("enforces request-wide checkpoint budget at %i", (count) => {
    const run = () =>
      translate(
        Array.from({ length: count }, (_, i) => ({
          role: "user",
          content: `part ${i}`,
          cache_control: marker,
        })),
      );
    if (count > 4) expect(run).toThrow(/four/);
    else
      expect(JSON.stringify(run()).match(/cachePoint/g)?.length ?? 0).toBe(
        count,
      );
  });

  test("counts tool-definition markers and validates tools → system → messages TTL order", () => {
    const tools = [
      {
        type: "function",
        function: { name: "read", parameters: {} },
        cache_control: marker,
      },
    ];
    expect(() =>
      translate(
        [
          {
            role: "system",
            content: "system",
            cache_control: { ...marker, ttl: "1h" },
          },
        ],
        { tools },
      ),
    ).toThrow(/precede/);
    expect(
      translate([{ role: "user", content: "question" }], { tools }).toolConfig
        ?.tools[1],
    ).toEqual(checkpoint);
    expect(() =>
      translate(
        Array.from({ length: 4 }, () => ({
          role: "user",
          content: "x",
          cache_control: marker,
        })),
        { tools },
      ),
    ).toThrow(/four/);
  });

  test.each([
    "amazon.nova-pro-v1:0",
    "eu.amazon.nova-lite-v1:0",
    "jp.amazon.nova-2-lite-v1:0",
    model,
    "global.anthropic.claude-opus-4-6-v1",
  ])("accepts documented model/profile %s", (modelId) => {
    expect(
      translate([{ role: "user", content: "x", cache_control: marker }], {
        model: modelId,
      }).messages?.[0].content[1],
    ).toEqual(checkpoint);
  });

  test.each([
    "zai.glm-4.7",
    "amazon.nova-micro-v1:0",
    "anthropic.claude-unknown",
    "anthropic.claude-sonnet-5-99",
    "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/opaque",
  ])("rejects unknown or unsupported marker capability %s", (modelId) => {
    expect(() =>
      translate([{ role: "user", content: "x", cache_control: marker }], {
        model: modelId,
      }),
    ).toThrow(/model ID/);
    expect(() =>
      translate([{ role: "user", content: "x" }], { model: modelId }),
    ).not.toThrow();
  });

  test("Nova restricts TTL and tool placement", () => {
    expect(() =>
      translate(
        [
          {
            role: "user",
            content: "x",
            cache_control: { ...marker, ttl: "1h" },
          },
        ],
        { model: "amazon.nova-pro-v1:0" },
      ),
    ).toThrow(/1h/);
    expect(() =>
      translate([{ role: "user", content: "x" }], {
        model: "amazon.nova-pro-v1:0",
        tools: [
          {
            type: "function",
            function: { name: "read" },
            cache_control: marker,
          },
        ],
      }),
    ).toThrow(/not tools/);
  });

  test("rejects malformed markers and shorter-before-longer TTL", () => {
    for (const cache_control of [
      null,
      { type: "default" },
      { ...marker, ttl: "30m" },
    ])
      expect(() =>
        translate([{ role: "user", content: "x", cache_control }]),
      ).toThrow(/cache_control/);
    expect(() =>
      translate([
        { role: "user", content: "x", cache_control: marker },
        { role: "user", content: "y", cache_control: { ...marker, ttl: "1h" } },
      ]),
    ).toThrow(/precede/);
  });
});

describe("Bedrock gross usage on each translated transport", () => {
  test.each([
    [0, 0],
    [9000, 0],
    [0, 9000],
    [8000, 1000],
  ])("reads %i and writes %i", (reads, writes) => {
    const native = {
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15 + reads + writes,
      cacheReadInputTokens: reads,
      cacheWriteInputTokens: writes,
      cacheDetails: writes ? [{ ttl: "1h" as const, inputTokens: writes }] : [],
    };
    const response = converseResponseToOpenai(
      {
        output: {
          message: { role: "assistant", content: [{ text: "answer" }] },
        },
        stopReason: "end_turn",
        usage: native,
      },
      ctx,
    );
    const responses = chatCompletionToResponses(response, {
      responseId: "resp_test",
      createdUnix: 1,
      requestedModel: model,
    });
    const wire = responses.usage as ReturnType<typeof toResponsesUsage>;
    expect(wire.input_tokens).toBe(12 + reads + writes);
    expect(wire.total_tokens).toBe(15 + reads + writes);
    expect(wire.input_tokens_details.cached_tokens).toBe(reads);
    expect(fromResponsesUsage(wire)).toMatchObject({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: reads,
      cacheWriteTokens: writes,
    });
    const encoder = createConverseToOpenaiSseEncoder(ctx);
    const event = encoder.encodeBedrockEvent({
      metadata: { usage: native, metrics: { latencyMs: 1 } },
    });
    expect(
      JSON.parse(new TextDecoder().decode(event ?? undefined).slice(6)).usage,
    ).toEqual(response.usage);
  });
});
