import { describe, expect, it } from "vitest";
import { createDirectLLMModel } from "@/clients/llm-client";
import { encodeOpenAiCodexCredential } from "@/services/openai-codex-credentials";
import type { CreateClientOptions } from "@/types";
import { openAiEmbeddingsAdapterFactory } from "./openai";
import { openAiResponsesAdapterFactory } from "./openai-responses";

const CODEX_CREDENTIAL = encodeOpenAiCodexCredential({
  refreshToken: "rt_secret",
  accountId: "acc_123",
});

const OPTIONS: CreateClientOptions = { source: "api" };

// A ChatGPT-subscription (Codex) credential must never be handed to a client
// pointed at api.openai.com — only the proxy chat/completions adapter decodes it
// and routes to the Codex backend. Every other openai entry point fails closed
// so the encoded OAuth refresh token can't leak.
describe("Codex credential guards keep the token off api.openai.com", () => {
  it("rejects a codex credential on the OpenAI Responses adapter", () => {
    expect(() =>
      openAiResponsesAdapterFactory.createClient(CODEX_CREDENTIAL, OPTIONS),
    ).toThrowError(/Responses endpoint/i);
  });

  it("rejects a codex credential on the OpenAI embeddings adapter", () => {
    expect(() =>
      openAiEmbeddingsAdapterFactory.createClient(CODEX_CREDENTIAL, OPTIONS),
    ).toThrowError(/embeddings/i);
  });

  it("rejects a codex credential on the direct LLM path (subagents / KB)", () => {
    expect(() =>
      createDirectLLMModel({
        provider: "openai",
        apiKey: CODEX_CREDENTIAL,
        modelName: "gpt-5.5-codex",
        baseUrl: null,
      }),
    ).toThrowError(/direct LLM path/i);
  });
});
