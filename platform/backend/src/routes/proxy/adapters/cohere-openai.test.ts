import { describe, expect, test } from "@/test";
import type { Cohere } from "@/types";
import { makeCohereOpenaiAdapterFactory } from "./cohere-openai";

const ctx = {
  chatcmplId: "chatcmpl-test",
  createdUnix: 123,
  requestedModel: "command-r-plus",
};

function createMockResponse(
  content: Cohere.Types.ChatResponse["message"]["content"],
  options?: {
    toolCalls?: Cohere.Types.ChatResponse["message"]["tool_calls"];
    finishReason?: Cohere.Types.ChatResponse["finish_reason"];
  },
): Cohere.Types.ChatResponse {
  return {
    id: "msg_test_123",
    message: {
      role: "assistant",
      content,
      tool_calls: options?.toolCalls,
    },
    finish_reason: options?.finishReason ?? "COMPLETE",
    usage: {
      tokens: { input_tokens: 100, output_tokens: 50 },
    },
  };
}

describe("CohereOpenaiResponseAdapter", () => {
  test("getLoggedResponse returns the inner Cohere shape (for interaction log)", () => {
    const response = createMockResponse([{ type: "text", text: "hi" }]);
    const adapter =
      makeCohereOpenaiAdapterFactory(ctx).createResponseAdapter(response);

    expect(adapter.getLoggedResponse?.()).toBe(response);
    // biome-ignore lint/suspicious/noExplicitAny: crossing typed boundary
    expect((adapter.getOriginalResponse() as any).object).toBe(
      "chat.completion",
    );
  });

  test("toRefusalResponse keeps the wire OpenAI-shaped but logs the native Cohere refusal", () => {
    const adapter = makeCohereOpenaiAdapterFactory(ctx).createResponseAdapter(
      createMockResponse(undefined, {
        toolCalls: [
          {
            id: "call_123",
            type: "function",
            function: { name: "lookup_secret", arguments: "{}" },
          },
        ],
        finishReason: "TOOL_CALLS",
      }),
    );

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

    // The interaction log must store the refusal in the inner Cohere shape,
    // not the blocked tool-call turn.
    // biome-ignore lint/suspicious/noExplicitAny: crossing typed boundary
    const logged = adapter.getLoggedResponse?.() as any;
    expect(logged.message.content).toEqual([
      { type: "text", text: "Sorry, that tool is disabled." },
    ]);
    expect(logged.message.tool_calls).toBeUndefined();
    expect(logged.finish_reason).toBe("COMPLETE");
  });
});
