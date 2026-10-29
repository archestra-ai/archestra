import { describe, expect, test } from "vitest";
import { encodeSignedToolCallId } from "../adapters/gemini-openai-translator";
import {
  withOpenAiChatToolCallIds,
  withOpenAiResponsesToolCallIds,
  wordToolCallId,
} from "./tool-call-ids";

// The id the Gemini translation hands a client: the call's thought signature
// rides inside it, so it runs to hundreds of characters and contains a dot.
const geminiId = encodeSignedToolCallId({
  id: "gemini-call-read-1",
  name: "read",
  thoughtSignature: "s".repeat(340),
});

// The id a Chat Completions tool result is forwarded with.
function openAiToolCallId(id: string): string {
  const [message] = withOpenAiChatToolCallIds([
    { role: "tool", tool_call_id: id, content: "" },
  ]);
  return message.role === "tool" ? message.tool_call_id : "";
}

describe("OpenAI tool-call ids", () => {
  test("keeps an id of up to 64 characters, whatever its characters", () => {
    expect(openAiToolCallId("call_abc")).toBe("call_abc");
    expect(openAiToolCallId("toolu_01.x:y")).toBe("toolu_01.x:y");
    expect(openAiToolCallId("c".repeat(64))).toBe("c".repeat(64));
  });

  test("replaces a longer id with the same short id on every turn", () => {
    expect(geminiId.length).toBeGreaterThan(400);
    const fitted = openAiToolCallId(geminiId);
    expect(fitted).toMatch(/^call_[0-9a-f]{32}$/);
    expect(openAiToolCallId(geminiId)).toBe(fitted);
    expect(openAiToolCallId(`${geminiId}x`)).not.toBe(fitted);
  });
});

describe("wordToolCallId", () => {
  test("keeps an id Anthropic and Bedrock accept", () => {
    expect(wordToolCallId("toolu_01AbC-9")).toBe("toolu_01AbC-9");
    expect(wordToolCallId("")).toBe("");
  });

  test("replaces an id with other characters or over 64 characters", () => {
    expect(wordToolCallId("call.0")).toMatch(/^call_[0-9a-f]{32}$/);
    expect(wordToolCallId("call.0")).not.toBe(wordToolCallId("call:0"));
    expect(wordToolCallId("c".repeat(65))).toMatch(/^call_[0-9a-f]{32}$/);
    expect(wordToolCallId(geminiId)).toBe(openAiToolCallId(geminiId));
  });
});

describe("withOpenAiChatToolCallIds", () => {
  test("gives a call and its result the same fitted id", () => {
    const messages = [
      { role: "user" as const, content: "Read a.txt" },
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: geminiId,
            type: "function" as const,
            function: { name: "read", arguments: "{}" },
          },
          {
            id: "call_short",
            type: "function" as const,
            function: { name: "read", arguments: "{}" },
          },
        ],
      },
      { role: "tool" as const, tool_call_id: geminiId, content: "a" },
      { role: "tool" as const, tool_call_id: "call_short", content: "b" },
    ];

    const fitted = withOpenAiChatToolCallIds(messages);

    const id = openAiToolCallId(geminiId);
    expect(fitted[1]).toMatchObject({
      tool_calls: [{ id }, { id: "call_short" }],
    });
    expect(fitted[2]).toMatchObject({ tool_call_id: id, content: "a" });
    expect(fitted[3]).toBe(messages[3]);
    expect(messages[2].tool_call_id).toBe(geminiId);
  });

  test("returns the messages as they are when every id fits", () => {
    const messages = [
      { role: "tool" as const, tool_call_id: "call_1", content: "a" },
    ];
    expect(withOpenAiChatToolCallIds(messages)[0]).toBe(messages[0]);
  });
});

describe("withOpenAiResponsesToolCallIds", () => {
  test("fits the call id and drops an item id over the limit", () => {
    const call = {
      type: "function_call",
      id: `fc_${geminiId}`,
      call_id: geminiId,
      name: "read",
      arguments: "{}",
    };
    const output = {
      type: "function_call_output",
      call_id: geminiId,
      output: "a",
    };

    const fittedCall = withOpenAiResponsesToolCallIds(call);
    const fittedOutput = withOpenAiResponsesToolCallIds(output);

    const callId = openAiToolCallId(geminiId);
    expect(fittedCall).toEqual({
      type: "function_call",
      call_id: callId,
      name: "read",
      arguments: "{}",
    });
    expect(fittedOutput).toEqual({ ...output, call_id: callId });
    expect(call.call_id).toBe(geminiId);
  });

  test("keeps an item whose ids fit, and items without a call id", () => {
    const call = {
      type: "function_call",
      id: "fc_gemini-call-read-1",
      call_id: "gemini-call-read-1",
      name: "read",
      arguments: "{}",
    };
    const message = { type: "message", role: "user", content: "hi" };
    expect(withOpenAiResponsesToolCallIds(call)).toBe(call);
    expect(withOpenAiResponsesToolCallIds(message)).toBe(message);
  });
});
