import { generateText } from "ai";
import { vi } from "vitest";
import { createDirectLLMModel } from "@/clients/llm-client";
import config from "@/config";
import { ModelModel } from "@/models";
import { describe, expect, test } from "@/test";

describe("anthropic output budget", () => {
  test("a catalogued model the SDK may not know gets the operator ceiling", async () => {
    await ModelModel.create({
      externalId: "anthropic/claude-sonnet-5",
      provider: "anthropic",
      modelId: "claude-sonnet-5",
      outputLength: 128_000,
      contextLength: 1_000_000,
      inputModalities: ["text"],
      outputModalities: ["text"],
    });

    expect(await sentMaxTokens({ modelName: "claude-sonnet-5" })).toBe(
      config.chat.maxOutputTokensCeiling,
    );
  });

  test("an id neither the catalog nor the SDK knows gets a budget every Claude model accepts", async () => {
    expect(await sentMaxTokens({ modelName: "claude-opus-4@20250514" })).toBe(
      8_192,
    );
  });

  test("an explicit caller budget wins", async () => {
    expect(
      await sentMaxTokens({
        modelName: "claude-sonnet-5",
        maxOutputTokens: 1_234,
      }),
    ).toBe(1_234);
  });

  test("a model whose own limit is lower is clamped by the SDK", async () => {
    expect(await sentMaxTokens({ modelName: "claude-3-haiku-20240307" })).toBe(
      4_096,
    );
  });
});

async function sentMaxTokens(params: {
  modelName: string;
  maxOutputTokens?: number;
}): Promise<number | undefined> {
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
      modelName: params.modelName,
      baseUrl: null,
    }),
    prompt: "hi",
    maxOutputTokens: params.maxOutputTokens,
    maxRetries: 0,
  }).catch(() => {});

  expect(sent).toHaveLength(1);
  return sent[0].max_tokens;
}
