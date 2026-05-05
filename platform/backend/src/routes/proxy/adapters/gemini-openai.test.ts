import { describe, expect, test } from "vitest";
import { makeGeminiOpenaiAdapterFactory } from "./gemini-openai";

describe("GeminiOpenaiStreamAdapter", () => {
  test("buffers OpenAI-shaped tool call events for policy evaluation", () => {
    const adapter = makeGeminiOpenaiAdapterFactory({
      chatcmplId: "chatcmpl-test",
      createdUnix: 123,
      requestedModel: "gemini:gemini-2.5-flash",
    }).createStreamAdapter();

    const result = adapter.processChunk({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  id: "call-1",
                  name: "lookup_secret",
                  args: { query: "blocked" },
                },
              },
            ],
            role: "model",
          },
          index: 0,
        },
      ],
      modelVersion: "gemini-2.5-flash",
      responseId: "gemini-response",
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    expect(result.isToolCallChunk).toBe(true);
    expect(result.sseData).toBeNull();

    const events = adapter.getRawToolCallEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('"object":"chat.completion.chunk"');
    expect(events[0]).toContain('"tool_calls"');
    expect(events[0]).toContain('"name":"lookup_secret"');
    expect(events[0]).toContain('"arguments":"{\\"query\\":\\"blocked\\"}"');
  });

  test("streams text chunks immediately", () => {
    const adapter = makeGeminiOpenaiAdapterFactory({
      chatcmplId: "chatcmpl-test",
      createdUnix: 123,
      requestedModel: "gemini:gemini-2.5-flash",
    }).createStreamAdapter();

    const result = adapter.processChunk({
      candidates: [
        {
          content: {
            parts: [{ text: "hello" }],
            role: "model",
          },
          index: 0,
        },
      ],
      modelVersion: "gemini-2.5-flash",
      responseId: "gemini-response",
    } as unknown as Parameters<typeof adapter.processChunk>[0]);

    expect(result.isToolCallChunk).toBe(false);
    expect(result.sseData).toContain('"content":"hello"');
    expect(adapter.getRawToolCallEvents()).toHaveLength(0);
  });
});
