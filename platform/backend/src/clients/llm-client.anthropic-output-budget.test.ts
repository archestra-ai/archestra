import { generateText } from "ai";
import { vi } from "vitest";
import { createDirectLLMModel } from "@/clients/llm-client";
import config from "@/config";
import { describe, expect, it } from "@/test";

describe("anthropic output budget", () => {
  it.each([
    [
      "an id the SDK does not know",
      "claude-future-9",
      undefined,
      config.chat.maxOutputTokensCeiling,
    ],
    [
      "a model that thinks by default",
      "claude-sonnet-5",
      undefined,
      config.chat.maxOutputTokensCeiling,
    ],
    ["an explicit caller budget", "claude-sonnet-5", 1_234, 1_234],
    [
      "a model whose own limit is lower",
      "claude-3-haiku-20240307",
      undefined,
      4_096,
    ],
  ])("sends max_tokens for %s", async (_, modelName, maxOutputTokens, expected) => {
    const sent: Array<{ max_tokens?: number }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init: RequestInit | undefined) => {
        sent.push(JSON.parse(init?.body as string));
        return new Response("upstream stub", { status: 500 });
      }),
    );

    await generateText({
      model: createDirectLLMModel({
        provider: "anthropic",
        apiKey: "test-key",
        modelName,
        baseUrl: null,
      }),
      prompt: "hi",
      maxOutputTokens,
      maxRetries: 0,
    }).catch(() => {});

    expect(sent).toHaveLength(1);
    expect(sent[0].max_tokens).toBe(expected);
  });
});
