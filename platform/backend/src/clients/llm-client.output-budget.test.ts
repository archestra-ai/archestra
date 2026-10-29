import type { SupportedProvider } from "@archestra/shared";
import { generateText } from "ai";
import { describe, expect, test, vi } from "vitest";
import { createDirectLLMModel } from "@/clients/llm-client";
import config from "@/config";
import { ModelModel } from "@/models";

describe("default output budget", () => {
  test("a catalogued model gets its catalog budget on every provider", async () => {
    for (const provider of ["anthropic", "openai", "gemini"] as const) {
      await ModelModel.create({
        externalId: `${provider}/thinks-by-default`,
        provider,
        modelId: "thinks-by-default",
        outputLength: 128_000,
        contextLength: 1_000_000,
        inputModalities: ["text"],
        outputModalities: ["text"],
      });

      expect(
        await sentMaxTokens({ provider, modelName: "thinks-by-default" }),
      ).toBe(config.chat.maxOutputTokensCeiling);
    }
  });

  test("an OpenAI chat model gets the budget as max_completion_tokens, and a caller's own one wins", async () => {
    await ModelModel.create({
      externalId: "openai/chat-latest",
      provider: "openai",
      modelId: "chat-latest",
      outputLength: 16_384,
      contextLength: 128_000,
      inputModalities: ["text"],
      outputModalities: ["text"],
    });

    const defaulted = await sentBody({
      provider: "openai",
      modelName: "chat-latest",
    });
    expect(defaulted.max_completion_tokens).toBe(16_384);
    expect(defaulted).not.toHaveProperty("max_tokens");

    const callers = await sentBody({
      provider: "openai",
      modelName: "chat-latest",
      providerOptions: { openai: { maxCompletionTokens: 1_234 } },
    });
    expect(callers.max_completion_tokens).toBe(1_234);
    expect(callers).not.toHaveProperty("max_tokens");

    const explicit = await sentBody({
      provider: "openai",
      modelName: "chat-latest",
      maxOutputTokens: 2_345,
    });
    expect(explicit.max_completion_tokens).toBe(2_345);
    expect(explicit).not.toHaveProperty("max_tokens");
  });

  test("Perplexity, though built on the OpenAI chat client, keeps max_tokens", async () => {
    await ModelModel.create({
      externalId: "perplexity/sonar",
      provider: "perplexity",
      modelId: "sonar",
      outputLength: 8_000,
      contextLength: 128_000,
      inputModalities: ["text"],
      outputModalities: ["text"],
    });

    const body = await sentBody({ provider: "perplexity", modelName: "sonar" });
    expect(body.max_tokens).toBe(8_000);
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  test("a shared-window model keeps its provider default, so a long prompt can use the leftover window", async () => {
    await ModelModel.create({
      externalId: "openai/gpt-4",
      provider: "openai",
      modelId: "gpt-4",
      outputLength: 8_192,
      contextLength: 8_192,
      inputModalities: ["text"],
      outputModalities: ["text"],
    });

    expect(
      await sentMaxTokens({ provider: "openai", modelName: "gpt-4" }),
    ).toBeUndefined();
  });

  test("an uncatalogued model keeps its provider default", async () => {
    expect(
      await sentMaxTokens({ provider: "openai", modelName: "gpt-unknown" }),
    ).toBeUndefined();
  });

  test("an uncatalogued Claude id gets a budget every Claude model accepts, not the SDK's table", async () => {
    expect(
      await sentMaxTokens({
        provider: "anthropic",
        modelName: "claude-opus-4@20250514",
      }),
    ).toBe(8_192);
  });

  test("an explicit caller budget wins", async () => {
    expect(
      await sentMaxTokens({
        provider: "openai",
        modelName: "gpt-unknown",
        maxOutputTokens: 1_234,
      }),
    ).toBe(1_234);
  });

  test("a Claude model whose own limit is lower is clamped by the SDK", async () => {
    expect(
      await sentMaxTokens({
        provider: "anthropic",
        modelName: "claude-3-haiku-20240307",
      }),
    ).toBe(4_096);
  });
});

/** The output cap the provider's wire request carries, by any of its names. */
async function sentMaxTokens(params: {
  provider: SupportedProvider;
  modelName: string;
  maxOutputTokens?: number;
}): Promise<number | undefined> {
  const body = await sentBody(params);
  const generationConfig = body.generationConfig as
    | Record<string, unknown>
    | undefined;
  const cap =
    body.max_tokens ??
    body.max_completion_tokens ??
    body.max_output_tokens ??
    generationConfig?.maxOutputTokens;
  return cap as number | undefined;
}

async function sentBody(params: {
  provider: SupportedProvider;
  modelName: string;
  maxOutputTokens?: number;
  providerOptions?: Parameters<typeof generateText>[0]["providerOptions"];
}): Promise<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init: RequestInit | undefined) => {
      sent.push(JSON.parse(init?.body as string));
      return new Response("upstream stub", { status: 500 });
    }),
  );

  await generateText({
    model: createDirectLLMModel({
      provider: params.provider,
      apiKey: "test-key",
      modelName: params.modelName,
      baseUrl: null,
    }),
    prompt: "hi",
    maxOutputTokens: params.maxOutputTokens,
    providerOptions: params.providerOptions,
    maxRetries: 0,
  }).catch(() => {});

  expect(sent).toHaveLength(1);
  return sent[0];
}
