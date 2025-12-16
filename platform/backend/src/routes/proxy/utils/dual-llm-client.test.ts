import config from "@/config";
import { describe, expect, test } from "@/test";
import {
  AnthropicDualLlmClient,
  createDualLlmClient,
  GeminiDualLlmClient,
  OpenAiDualLlmClient,
} from "./dual-llm-client";

describe("dual-llm-client", () => {
  describe("createDualLlmClient factory", () => {
    test("creates OpenAI client with API key", () => {
      const client = createDualLlmClient("openai", "test-api-key");
      expect(client).toBeInstanceOf(OpenAiDualLlmClient);
    });

    test("throws error for OpenAI without API key", () => {
      expect(() => createDualLlmClient("openai", undefined)).toThrow(
        "API key required for OpenAI dual LLM",
      );
    });

    test("creates Anthropic client with API key", () => {
      const client = createDualLlmClient("anthropic", "test-api-key");
      expect(client).toBeInstanceOf(AnthropicDualLlmClient);
    });

    test("throws error for Anthropic without API key", () => {
      expect(() => createDualLlmClient("anthropic", undefined)).toThrow(
        "API key required for Anthropic dual LLM",
      );
    });

    test("creates Gemini client with API key when Vertex AI disabled", () => {
      // Ensure Vertex AI is disabled for this test
      const originalEnabled = config.llm.gemini.vertexAi.enabled;
      config.llm.gemini.vertexAi.enabled = false;

      try {
        const client = createDualLlmClient("gemini", "test-api-key");
        expect(client).toBeInstanceOf(GeminiDualLlmClient);
      } finally {
        config.llm.gemini.vertexAi.enabled = originalEnabled;
      }
    });

    test("throws error for Gemini without API key when Vertex AI disabled", () => {
      // Ensure Vertex AI is disabled for this test
      const originalEnabled = config.llm.gemini.vertexAi.enabled;
      config.llm.gemini.vertexAi.enabled = false;

      try {
        expect(() => createDualLlmClient("gemini", undefined)).toThrow(
          "API key required for Gemini when Vertex AI mode is disabled",
        );
      } finally {
        config.llm.gemini.vertexAi.enabled = originalEnabled;
      }
    });

    test("throws error for unsupported provider", () => {
      // @ts-expect-error - testing runtime error for invalid provider
      expect(() => createDualLlmClient("invalid-provider", "test-key")).toThrow(
        "Unsupported provider for Dual LLM: invalid-provider",
      );
    });
  });

  describe("GeminiDualLlmClient Vertex AI configuration", () => {
    test("throws error when Vertex AI enabled but project not set", () => {
      // Save original values
      const originalEnabled = config.llm.gemini.vertexAi.enabled;
      const originalProject = config.llm.gemini.vertexAi.project;

      // Enable Vertex AI without project
      config.llm.gemini.vertexAi.enabled = true;
      config.llm.gemini.vertexAi.project = "";

      try {
        expect(() => new GeminiDualLlmClient(undefined)).toThrow(
          "Vertex AI is enabled but ARCHESTRA_GEMINI_VERTEX_AI_PROJECT is not set",
        );
      } finally {
        // Restore original values
        config.llm.gemini.vertexAi.enabled = originalEnabled;
        config.llm.gemini.vertexAi.project = originalProject;
      }
    });

    test("creates Vertex AI client when enabled with project (no API key required)", () => {
      // Save original values
      const originalEnabled = config.llm.gemini.vertexAi.enabled;
      const originalProject = config.llm.gemini.vertexAi.project;
      const originalLocation = config.llm.gemini.vertexAi.location;

      // Enable Vertex AI with project
      config.llm.gemini.vertexAi.enabled = true;
      config.llm.gemini.vertexAi.project = "my-gcp-project";
      config.llm.gemini.vertexAi.location = "us-central1";

      try {
        // Should not throw - API key not required for Vertex AI
        const client = new GeminiDualLlmClient(undefined);
        expect(client).toBeInstanceOf(GeminiDualLlmClient);
      } finally {
        // Restore original values
        config.llm.gemini.vertexAi.enabled = originalEnabled;
        config.llm.gemini.vertexAi.project = originalProject;
        config.llm.gemini.vertexAi.location = originalLocation;
      }
    });

    test("allows API key to be provided even when Vertex AI enabled (uses Vertex AI)", () => {
      // Save original values
      const originalEnabled = config.llm.gemini.vertexAi.enabled;
      const originalProject = config.llm.gemini.vertexAi.project;

      // Enable Vertex AI with project
      config.llm.gemini.vertexAi.enabled = true;
      config.llm.gemini.vertexAi.project = "my-gcp-project";

      try {
        // Should still work - Vertex AI takes precedence
        const client = new GeminiDualLlmClient("test-api-key");
        expect(client).toBeInstanceOf(GeminiDualLlmClient);
      } finally {
        // Restore original values
        config.llm.gemini.vertexAi.enabled = originalEnabled;
        config.llm.gemini.vertexAi.project = originalProject;
      }
    });
  });
});
