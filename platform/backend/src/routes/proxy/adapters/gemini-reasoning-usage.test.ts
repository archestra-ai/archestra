import { describe, expect, test } from "vitest";
import type { Gemini } from "@/types";
import { makeGeminiOpenaiAdapterFactory } from "./gemini-openai";
import { geminiUsageToOpenai } from "./gemini-openai-translator";
import { makeResponsesFromChatAdapterFactory } from "./openai-responses-from-chat";

const context = {
  chatcmplId: "chatcmpl-test",
  createdUnix: 0,
  requestedModel: "gemini:gemini-2.5-flash",
};
const response: Gemini.Types.GenerateContentResponse = {
  responseId: "gemini-test",
  modelVersion: "gemini-2.5-flash",
  candidates: [
    {
      index: 0,
      content: { role: "model", parts: [{ text: "Answer" }] },
      finishReason: "STOP",
    },
  ],
  usageMetadata: {
    promptTokenCount: 2000,
    cachedContentTokenCount: 1800,
    candidatesTokenCount: 100,
    thoughtsTokenCount: 500,
    totalTokenCount: 2600,
  },
};
const chatUsage = {
  prompt_tokens: 2000,
  completion_tokens: 600,
  completion_tokens_details: { reasoning_tokens: 500 },
  total_tokens: 2600,
};
const responsesUsage = {
  input_tokens: 2000,
  output_tokens: 600,
  output_tokens_details: { reasoning_tokens: 500 },
  total_tokens: 2600,
};

describe("Gemini reasoning usage reaches OpenAI clients", () => {
  for (const transport of ["chat", "responses"] as const) {
    for (const refusal of [false, true]) {
      test(`${transport} ${refusal ? "refusal" : "normal"} response includes reasoning in completion usage`, () => {
        const factory = makeFactory(transport);
        const adapter = factory.createResponseAdapter(response);
        const result = refusal
          ? adapter.toRefusalResponse("Blocked", "Refused")
          : adapter.getOriginalResponse();
        expect(result).toMatchObject({
          usage: transport === "chat" ? chatUsage : responsesUsage,
        });
        // Reporting wire totals must not change the provider-domain counters
        // used for logging and cost calculation.
        expect(adapter.getUsage()).toMatchObject({
          inputTokens: 200,
          outputTokens: 100,
          reasoningTokens: 500,
        });
      });

      test(`${transport} ${refusal ? "refusal" : "normal"} stream includes reasoning in terminal usage`, () => {
        const adapter = makeFactory(transport).createStreamAdapter();
        adapter.processChunk(
          response as unknown as Parameters<typeof adapter.processChunk>[0],
        );
        const sse = refusal
          ? adapter.formatCompleteTextSSE("Refused")
          : adapter.formatEndSSE();
        const parts = Array.isArray(sse) ? sse : [sse];
        const text = [...parts, adapter.formatEndSSE()]
          .map((part) =>
            typeof part === "string" ? part : new TextDecoder().decode(part),
          )
          .join("");
        const events = text
          .split("\n\n")
          .filter((part) => part.startsWith("data: {"))
          .map((part) => JSON.parse(part.slice(6)));
        const usage =
          transport === "chat"
            ? events.find((event) => event.usage)?.usage
            : events.find((event) => event.type === "response.completed")
                ?.response.usage;
        expect(usage).toMatchObject(
          transport === "chat" ? chatUsage : responsesUsage,
        );
      });
    }
  }

  test("Responses tool-call completion includes reasoning exactly once", () => {
    const adapter = makeFactory("responses").createStreamAdapter();
    adapter.processChunk({
      ...response,
      candidates: [
        {
          index: 0,
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  id: "call-test",
                  name: "lookup",
                  args: {},
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    } as unknown as Parameters<typeof adapter.processChunk>[0]);
    const frames = adapter.formatToolCallsSSE?.(adapter.state.toolCalls) ?? [];
    const wire = [...frames, adapter.formatEndSSE()].join("");
    const events = wire
      .split("\n\n")
      .filter((part) => part.startsWith("data: {"))
      .map((part) => JSON.parse(part.slice(6)));
    const completions = events.filter(
      (event) => event.type === "response.completed",
    );
    expect(completions).toHaveLength(1);
    expect(completions[0].response.usage).toMatchObject(responsesUsage);
  });

  test("missing provider total still counts reasoning once", () => {
    expect(
      geminiUsageToOpenai({
        ...response,
        usageMetadata: {
          ...response.usageMetadata,
          totalTokenCount: undefined,
        },
      }),
    ).toMatchObject(chatUsage);
  });
});

function makeFactory(transport: "chat" | "responses") {
  const factory = makeGeminiOpenaiAdapterFactory(context);
  return transport === "chat"
    ? factory
    : makeResponsesFromChatAdapterFactory(factory, {
        responseId: "resp-test",
        createdUnix: 0,
        requestedModel: context.requestedModel,
      });
}
