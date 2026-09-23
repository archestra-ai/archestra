import { describe, expect, test } from "vitest";
import type { Gemini } from "@/types";
import { makeGeminiOpenaiAdapterFactory } from "./gemini-openai";
import { GeminiToolNameCodec } from "./gemini-tool-names";

describe("GeminiOpenaiResponseAdapter", () => {
  test("toRefusalResponse keeps the wire OpenAI-shaped but logs the native Gemini refusal", () => {
    const adapter = makeGeminiOpenaiAdapterFactory({
      chatcmplId: "chatcmpl-test",
      createdUnix: 123,
      requestedModel: "gemini:gemini-2.5-flash",
    }).createResponseAdapter({
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
          finishReason: "STOP",
          index: 0,
        },
      ],
      modelVersion: "gemini-2.5-flash",
      responseId: "gemini-response",
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
    } as unknown as Gemini.Types.GenerateContentResponse);

    const refusal = adapter.toRefusalResponse(
      "blocked by policy",
      "Sorry, that tool is disabled.",
      // biome-ignore lint/suspicious/noExplicitAny: crossing typed boundary
    ) as any;
    expect(refusal.object).toBe("chat.completion");
    expect(refusal.choices[0].finish_reason).toBe("stop");
    expect(refusal.choices[0].message.content).toBe(
      "Sorry, that tool is disabled.",
    );

    // The interaction log must store the refusal in the inner Gemini shape,
    // not the blocked functionCall turn.
    const logged = adapter.getLoggedResponse?.() as unknown as
      | Gemini.Types.GenerateContentResponse
      | undefined;
    expect(logged?.candidates?.[0]?.content?.parts).toEqual([
      { text: "Sorry, that tool is disabled." },
    ]);
    expect(logged?.candidates?.[0]?.finishReason).toBe("STOP");
  });
});

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

  test.each([
    false,
    true,
  ])("ends a function-calling turn with the client-visible finish reason (refused=%s)", (refused) => {
    const adapter = makeGeminiOpenaiAdapterFactory({
      chatcmplId: "chatcmpl-test",
      createdUnix: 123,
      requestedModel: "gemini:gemini-2.5-flash",
    }).createStreamAdapter();

    adapter.processChunk({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { id: "call-1", name: "read", args: { p: "a" } },
              },
            ],
            role: "model",
          },
          finishReason: "STOP",
          index: 0,
        },
      ],
      modelVersion: "gemini-2.5-flash",
      responseId: "gemini-response",
    } as unknown as Parameters<typeof adapter.processChunk>[0]);
    if (refused) {
      adapter.formatCompleteTextSSE("blocked by policy");
    } else {
      adapter.formatToolCallsSSE?.(adapter.state.toolCalls);
    }
    expect(adapter.formatEndSSE()).toContain(
      `"finish_reason":"${refused ? "stop" : "tool_calls"}"`,
    );
  });

  test("restores client tool names in OpenAI-shaped stream events", () => {
    const clientToolName = "1 report/tool";
    const request = {
      contents: [{ role: "user", parts: [{ text: "Create the report" }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: clientToolName,
              description: "Create a report",
              parameters: { type: "object" },
            },
          ],
        },
      ],
    } as Gemini.Types.GenerateContentRequest;
    const providerRequest = new GeminiToolNameCodec(request).encodeRequest(
      request,
    );
    const providerTools = Array.isArray(providerRequest.tools)
      ? providerRequest.tools
      : [providerRequest.tools];
    const providerToolName =
      providerTools[0]?.functionDeclarations?.[0]?.name ?? "";
    const adapter = makeGeminiOpenaiAdapterFactory({
      chatcmplId: "chatcmpl-test",
      createdUnix: 123,
      requestedModel: "gemini:gemini-2.5-flash",
    }).createStreamAdapter(request);

    adapter.processChunk({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  id: "call-1",
                  name: providerToolName,
                  args: { reportId: "weekly" },
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

    expect(adapter.state.toolCalls[0].name).toBe(clientToolName);
    expect(adapter.getRawToolCallEvents()[0]).toContain(
      `"name":"${clientToolName}"`,
    );
  });
});
