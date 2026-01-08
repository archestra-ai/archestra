import { describe, expect, test } from "@/test";
import { mapOpenAiModelToModelInfo } from "./chat-models";

describe("mapOpenAiModelToModelInfo", () => {
  describe("OpenAi.Types.Model", () => {
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
  });

  describe("OpenAi.Types.OrlandoModel", () => {
    test("maps Claude model with anthropic provider", () => {
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

    test("maps Gemini model with gemini provider", () => {
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

    test("maps GPT model with openai provider", () => {
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
});
