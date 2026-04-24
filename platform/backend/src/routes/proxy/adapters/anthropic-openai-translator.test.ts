import { describe, expect, test } from "vitest";
import { openaiToAnthropic, anthropicResponseToOpenai } from "./anthropic-openai-translator";

describe("Anthropic-OpenAI Translator", () => {
  test("translates OpenAI request to Anthropic", () => {
    const openaiReq = {
      model: "claude-3-sonnet",
      messages: [
        { role: "system", content: "You are a helper" },
        { role: "user", content: "Hello" }
      ],
      temperature: 0.7,
    };

    const { anthropicBody, openaiContext } = openaiToAnthropic(openaiReq as any);

    expect(anthropicBody.model).toBe("claude-3-sonnet");
    expect(anthropicBody.system).toBe("You are a helper");
    expect(anthropicBody.messages).toHaveLength(1);
    expect(anthropicBody.messages[0].role).toBe("user");
    expect(openaiContext.requestedModel).toBe("claude-3-sonnet");
  });

  test("translates Anthropic response to OpenAI", () => {
    const anthropicResp = {
      id: "msg_123",
      content: [{ type: "text", text: "Hello back" }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: "end_turn",
    };

    const ctx = {
      chatcmplId: "chatcmpl-test",
      createdUnix: 123456789,
      requestedModel: "claude-3-sonnet",
      includeUsageInStream: false,
    };

    const openaiResp = anthropicResponseToOpenai(anthropicResp as any, ctx);

    expect(openaiResp.id).toBe("chatcmpl-test");
    expect(openaiResp.choices[0].message.content).toBe("Hello back");
    expect(openaiResp.usage.total_tokens).toBe(15);
  });
});
