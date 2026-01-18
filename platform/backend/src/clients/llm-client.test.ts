import { describe, expect, it } from "@/test";
import { detectProviderFromModel } from "./llm-client";

describe("detectProviderFromModel", () => {
  describe("anthropic models", () => {
    it("detects claude models as anthropic", () => {
      expect(detectProviderFromModel("claude-3-haiku-20240307")).toBe(
        "anthropic",
      );
      expect(detectProviderFromModel("claude-3-opus-20240229")).toBe(
        "anthropic",
      );
      expect(detectProviderFromModel("claude-opus-4-1-20250805")).toBe(
        "anthropic",
      );
      expect(detectProviderFromModel("Claude-3-Sonnet")).toBe("anthropic");
    });
  });

  describe("gemini models", () => {
    it("detects gemini models as gemini", () => {
      expect(detectProviderFromModel("gemini-2.5-pro")).toBe("gemini");
      expect(detectProviderFromModel("gemini-1.5-flash")).toBe("gemini");
      expect(detectProviderFromModel("Gemini-Pro")).toBe("gemini");
    });

    it("detects google models as gemini", () => {
      expect(detectProviderFromModel("google-palm")).toBe("gemini");
    });
  });

  describe("openai models", () => {
    it("detects gpt models as openai", () => {
      expect(detectProviderFromModel("gpt-4o")).toBe("openai");
      expect(detectProviderFromModel("gpt-4-turbo")).toBe("openai");
      expect(detectProviderFromModel("GPT-4")).toBe("openai");
    });

    it("detects o1 models as openai", () => {
      expect(detectProviderFromModel("o1-preview")).toBe("openai");
      expect(detectProviderFromModel("o1-mini")).toBe("openai");
    });

    it("detects o3 models as openai", () => {
      expect(detectProviderFromModel("o3-mini")).toBe("openai");
    });
  });

  describe("unknown models", () => {
    it("defaults to anthropic for unknown models", () => {
      expect(detectProviderFromModel("some-unknown-model")).toBe("anthropic");
      expect(detectProviderFromModel("custom-model")).toBe("anthropic");
    });
  });
});
