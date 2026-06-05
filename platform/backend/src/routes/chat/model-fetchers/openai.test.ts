import { vi } from "vitest";
import { describe, expect, test } from "@/test";
import { fetchOpenAiModels, mapOpenAiModelToModelInfo } from "./openai";
import { fetchModelsWithBearerAuth } from "./openai-compatible";

vi.mock("./openai-compatible", () => ({
  fetchModelsWithBearerAuth: vi.fn(),
}));

describe("mapOpenAiModelToModelInfo", () => {
  test("maps standard OpenAI model", () => {
    const result = mapOpenAiModelToModelInfo({
      id: "gpt-4o",
      created: 1715367049,
      object: "model",
      owned_by: "openai",
    });

    expect(result).toEqual({
      id: "gpt-4o",
      displayName: "gpt-4o",
      provider: "openai",
      createdAt: new Date(1715367049 * 1000).toISOString(),
    });
  });

  test("maps Claude proxy model to anthropic", () => {
    const result = mapOpenAiModelToModelInfo({
      id: "claude-3-5-sonnet",
      name: "claude-3-5-sonnet",
    });

    expect(result).toEqual({
      id: "claude-3-5-sonnet",
      displayName: "claude-3-5-sonnet",
      provider: "anthropic",
      createdAt: undefined,
    });
  });

  test("maps Gemini proxy model to gemini", () => {
    const result = mapOpenAiModelToModelInfo({
      id: "gemini-2.5-pro",
      name: "gemini-2.5-pro",
    });

    expect(result).toEqual({
      id: "gemini-2.5-pro",
      displayName: "gemini-2.5-pro",
      provider: "gemini",
      createdAt: undefined,
    });
  });

  test("defaults Orlando GPT models to openai", () => {
    const result = mapOpenAiModelToModelInfo({
      id: "gpt-5",
      name: "gpt-5",
    });

    expect(result).toEqual({
      id: "gpt-5",
      displayName: "gpt-5",
      provider: "openai",
      createdAt: undefined,
    });
  });
});

describe("fetchOpenAiModels exclusion", () => {
  test.each([
    { id: "gpt-4o", included: true },
    { id: "chatgpt-4o-latest", included: true },
    { id: "gpt-5.5-pro", included: true },
    { id: "babbage-002", included: false },
    { id: "davinci-002", included: false },
    { id: "gpt-3.5-turbo-instruct", included: false },
    { id: "whisper-1", included: false },
    { id: "dall-e-3", included: false },
    { id: "tts-1", included: false },
  ])("$id -> included=$included", async ({ id, included }) => {
    vi.mocked(fetchModelsWithBearerAuth).mockResolvedValue({
      data: [{ id, object: "model", owned_by: "openai", created: 1 }],
    });

    const models = await fetchOpenAiModels("test-key");

    expect(models.some((model) => model.id === id)).toBe(included);
  });
});
