import { describe, expect, test } from "vitest";
import type { Gemini } from "@/types";
import { makeGeminiOpenaiAdapterFactory } from "./gemini-openai";
import { decodeSignedToolCallId } from "./gemini-openai-translator";
import { GeminiToolNameCodec } from "./gemini-tool-names";

describe("GeminiOpenaiResponseAdapter", () => {
  test.for([
    { indexed: true, firstCalls: true },
    { indexed: true, firstCalls: false },
    { indexed: false, firstCalls: true },
    { indexed: false, firstCalls: false },
  ])("uses the same candidate-zero view for policy, wire and audit ($indexed/$firstCalls)", ({
    indexed,
    firstCalls,
  }) => {
    const adapter = makeGeminiOpenaiAdapterFactory({
      chatcmplId: "chatcmpl-test",
      createdUnix: 123,
      requestedModel: "pool",
    }).createResponseAdapter({
      candidates: [0, 1].map((index) => ({
        ...(indexed ? { index } : {}),
        content: {
          role: "model",
          parts:
            index === 0 && !firstCalls
              ? [{ text: "answer" }]
              : [
                  {
                    functionCall: {
                      id: `call-${index}`,
                      name: `lookup_${index}`,
                      args: {},
                    },
                    thoughtSignature: `signature-${index}`,
                  },
                ],
        },
        finishReason: "STOP",
      })),
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 40 },
    } as Gemini.Types.GenerateContentResponse);
    expect(adapter.getToolCalls().map((call) => call.id)).toEqual(
      firstCalls ? ["call-0"] : [],
    );
    expect(adapter.hasToolCalls()).toBe(firstCalls);
    for (const response of [
      adapter.getOriginalResponse(),
      adapter.getLoggedResponse?.(),
    ]) {
      expect(JSON.stringify(response)).not.toContain("lookup_1");
      if (firstCalls) expect(JSON.stringify(response)).toContain("lookup_0");
    }
    expect(adapter.getUsage()).toMatchObject({
      inputTokens: 12,
      outputTokens: 40,
    });
    const approved = adapter
      .getToolCalls()
      .map((call) => ({ ...call, name: "policy_notice", arguments: "{}" }));
    const rewritten = adapter.withRewrittenToolCalls?.(approved);
    expect(JSON.stringify(rewritten)).not.toContain("lookup_1");
    expect(JSON.stringify(adapter.getLoggedResponse?.())).not.toContain(
      "lookup_1",
    );
    if (firstCalls) {
      expect(JSON.stringify(rewritten)).toContain("policy_notice");
      expect(JSON.stringify(adapter.getLoggedResponse?.())).toContain(
        "signature-0",
      );
    }
    // A plugin cannot introduce an alternative candidate that policy never saw.
    expect(() =>
      adapter.withRewrittenToolCalls?.([
        { id: "call-1", name: "lookup_1", arguments: "{}" },
      ]),
    ).toThrow();
    adapter.withRewrittenToolCalls?.([]);
    expect(JSON.stringify(adapter.getLoggedResponse?.())).not.toContain(
      "functionCall",
    );
  });

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
  test("saves reordered approved calls in the OpenAI client's emitted order", () => {
    const adapter = makeGeminiOpenaiAdapterFactory({
      chatcmplId: "call-order",
      createdUnix: 1,
      requestedModel: "pool",
    }).createStreamAdapter();
    adapter.processChunk({
      candidates: [
        {
          index: 0,
          content: {
            role: "model",
            parts: [0, 1].map((index) => ({
              functionCall: {
                id: `call-${index}`,
                name: "lookup",
                args: { index },
              },
              thoughtSignature: `signature-${index}`,
            })),
          },
        },
      ],
    } as unknown as Parameters<typeof adapter.processChunk>[0]);
    const approved = [...adapter.state.toolCalls].reverse();
    const frames = adapter.formatToolCallsSSE?.(approved);
    const emitted = JSON.parse(String(frames?.[0]).slice(6)).choices[0].delta
      .tool_calls;
    adapter.state.toolCalls.splice(
      0,
      adapter.state.toolCalls.length,
      ...approved,
    );
    const logged = adapter.toProviderResponse().candidates?.[0].content?.parts;
    expect(
      emitted.map((call: { id: string }) => decodeSignedToolCallId(call.id).id),
    ).toEqual(["call-1", "call-0"]);
    expect(
      logged?.map((part) =>
        "functionCall" in part ? part.functionCall?.id : undefined,
      ),
    ).toEqual(["call-1", "call-0"]);
    expect(logged?.map((part) => part.thoughtSignature)).toEqual([
      "signature-1",
      "signature-0",
    ]);
  });

  test("keeps the retained call's signature when policy removes an earlier call", () => {
    const adapter = makeGeminiOpenaiAdapterFactory({
      chatcmplId: "chatcmpl-test",
      createdUnix: 123,
      requestedModel: "pool",
    }).createStreamAdapter();
    adapter.processChunk({
      candidates: [
        {
          index: 0,
          content: {
            role: "model",
            parts: [0, 1].map((index) => ({
              functionCall: { id: `call-${index}`, name: "lookup", args: {} },
              thoughtSignature: `signature-${index}`,
            })),
          },
        },
      ],
    } as Parameters<typeof adapter.processChunk>[0]);
    const approved = [adapter.state.toolCalls[1]];
    const frames = adapter.formatToolCallsSSE?.(approved);
    const wireCall = JSON.parse(String(frames?.[0]).slice(6)).choices[0].delta
      .tool_calls[0];
    expect(decodeSignedToolCallId(wireCall.id)).toMatchObject({
      id: "call-1",
      thoughtSignature: "signature-1",
    });
    adapter.state.toolCalls.splice(
      0,
      adapter.state.toolCalls.length,
      ...approved,
    );
    expect(adapter.toProviderResponse().candidates?.[0].content?.parts).toEqual(
      [
        {
          functionCall: { id: "call-1", name: "lookup", args: {} },
          thoughtSignature: "signature-1",
        },
      ],
    );
  });

  test.for([
    true,
    false,
  ])("keeps its single-choice calls aligned when upstream includes alternatives (first calls=%s)", (firstCalls) => {
    const adapter = makeGeminiOpenaiAdapterFactory({
      chatcmplId: "chatcmpl-test",
      createdUnix: 123,
      requestedModel: "pool",
    }).createStreamAdapter();
    adapter.processChunk({
      candidates: [0, 1].map((index) => ({
        index,
        content: {
          role: "model",
          parts:
            index === 0 && !firstCalls
              ? [{ text: "answer" }]
              : [
                  {
                    functionCall: {
                      id: `call-${index}`,
                      name: `lookup_${index}`,
                      args: {},
                    },
                  },
                ],
        },
      })),
    } as Parameters<typeof adapter.processChunk>[0]);
    expect(adapter.state.toolCalls.map((call) => call.name)).toEqual(
      firstCalls ? ["lookup_0"] : [],
    );
    const raw = adapter.getRawToolCallEvents().join("");
    expect(raw).not.toContain("lookup_1");
    if (firstCalls) expect(raw).toContain("lookup_0");
    else expect(raw).toBe("");
    expect(JSON.stringify(adapter.toProviderResponse())).not.toContain(
      "lookup_1",
    );
  });

  test("keeps every text and signed tool part while withholding thought text", () => {
    const adapter = makeGeminiOpenaiAdapterFactory({
      chatcmplId: "chatcmpl-test",
      createdUnix: 123,
      requestedModel: "pool",
    }).createStreamAdapter();
    const result = adapter.processChunk({
      candidates: [
        {
          index: 0,
          content: {
            role: "model",
            parts: [
              { thought: true, text: "private reasoning" },
              { text: "first" },
              {
                functionCall: { id: "one", name: "read_one", args: {} },
                thoughtSignature: "sig-one",
              },
              { text: "second" },
              {
                functionCall: { id: "two", name: "read_two", args: {} },
                thoughtSignature: "sig-two",
              },
            ],
          },
        },
      ],
    } as Parameters<typeof adapter.processChunk>[0]);
    expect(result.sseData).toContain('"content":"first"');
    expect(result.sseData).toContain('"content":"second"');
    expect(result.sseData).not.toContain("private reasoning");
    expect(result.sseData).not.toContain("tool_calls");
    const events = adapter.getRawToolCallEvents().join("");
    expect(events).toContain('"index":0');
    expect(events).toContain('"index":1');
    expect(events).toContain('"name":"read_one"');
    expect(events).toContain('"name":"read_two"');
    const released = adapter
      .formatToolCallsSSE?.(adapter.state.toolCalls)
      ?.join("");
    for (const call of adapter.state.toolCalls)
      expect(released).toContain(call.name);
    expect(released).toContain("gemsig-");
  });

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
