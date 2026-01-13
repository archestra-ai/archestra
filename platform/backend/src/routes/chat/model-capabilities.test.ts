import type { ModelCapabilities, ModelCapability } from "@shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCapabilitiesCache,
  fetchModelCapabilitiesFromOpenRouter,
  getModelCapabilities,
  type OpenRouterModel,
  resolveCapabilitiesFromModel,
  resolveFallbackCapabilities,
  validateCapabilities,
} from "./model-capabilities";

describe("model-capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCapabilitiesCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("resolveCapabilitiesFromModel", () => {
    it("should extract capabilities from model architecture", () => {
      const model: OpenRouterModel = {
        id: "test-model",
        name: "Test Model",
        created: Date.now(),
        context_length: 128000,
        architecture: {
          modality: "text -> text",
          input_modalities: ["image", "text"],
          output_modalities: ["text"],
          tokenizer: "test-tokenizer",
          instruct_type: null,
        },
      };

      const result = resolveCapabilitiesFromModel(model);

      expect(result.capabilities).toContain("vision");
      expect(result.capabilities).toContain("multimodal");
      expect(result.capabilities).toContain("chat");
      expect(result.capabilities).toContain("streaming");
      expect(result.metadata?.supportsImages).toBe(true);
      expect(result.metadata?.maxTokens).toBe(128000);
    });

    it("should handle audio capabilities", () => {
      const model: OpenRouterModel = {
        id: "audio-model",
        name: "Audio Model",
        created: Date.now(),
        context_length: 64000,
        architecture: {
          modality: "audio -> text",
          input_modalities: ["audio"],
          output_modalities: ["text"],
          tokenizer: "test-tokenizer",
          instruct_type: null,
        },
      };

      const result = resolveCapabilitiesFromModel(model);

      expect(result.capabilities).toContain("audio");
      expect(result.metadata?.supportsAudio).toBe(true);
    });

    it("should handle video capabilities", () => {
      const model: OpenRouterModel = {
        id: "video-model",
        name: "Video Model",
        created: Date.now(),
        context_length: 64000,
        architecture: {
          modality: "video -> text",
          input_modalities: ["video"],
          output_modalities: ["text"],
          tokenizer: "test-tokenizer",
          instruct_type: null,
        },
      };

      const result = resolveCapabilitiesFromModel(model);

      expect(result.capabilities).toContain("vision");
      expect(result.metadata?.supportsVideo).toBe(true);
      expect(result.metadata?.supportsImages).toBe(true);
    });

    it("should add context-window capability for large context models", () => {
      const model: OpenRouterModel = {
        id: "large-context-model",
        name: "Large Context Model",
        created: Date.now(),
        context_length: 200000,
        architecture: {
          modality: "text -> text",
          input_modalities: ["text"],
          output_modalities: ["text"],
          tokenizer: "test-tokenizer",
          instruct_type: null,
        },
      };

      const result = resolveCapabilitiesFromModel(model);

      expect(result.capabilities).toContain("context-window");
    });

    it("should include top provider metadata when available", () => {
      const model: OpenRouterModel = {
        id: "model-with-provider",
        name: "Model with Provider",
        created: Date.now(),
        context_length: 128000,
        architecture: {
          modality: "text -> text",
          input_modalities: ["text"],
          output_modalities: ["text"],
          tokenizer: "test-tokenizer",
          instruct_type: null,
        },
        top_provider: {
          context_length: 128000,
          max_completion_tokens: 4096,
          is_moderated: true,
        },
      };

      const result = resolveCapabilitiesFromModel(model);

      // Basic metadata should be present
      expect(result.metadata?.maxTokens).toBe(128000);
    });
  });

  describe("resolveFallbackCapabilities", () => {
    it("should return basic capabilities for any model", () => {
      const result = resolveFallbackCapabilities("test-model", "openai");

      expect(result.capabilities).toContain("streaming");
      expect(result.capabilities).toContain("chat");
      expect(result.metadata?.supportsStreaming).toBe(true);
    });

    it("should return streaming metadata by default", () => {
      const result = resolveFallbackCapabilities("test-model", "openai");

      expect(result.metadata?.supportsStreaming).toBe(true);
    });
  });

  describe("validateCapabilities", () => {
    it("should filter out invalid capabilities", () => {
      const input: ModelCapabilities = {
        capabilities: [
          "chat",
          "vision",
          "invalid-capability" as ModelCapability,
        ],
        metadata: { supportsImages: true },
      };

      const result = validateCapabilities(input);

      expect(result.capabilities).toEqual(["chat", "vision"]);
      expect(result.metadata?.supportsImages).toBe(true);
    });

    it("should return empty array when all capabilities are invalid", () => {
      const input: ModelCapabilities = {
        capabilities: [
          "invalid-1" as ModelCapability,
          "invalid-2" as ModelCapability,
        ],
      };

      const result = validateCapabilities(input);

      expect(result.capabilities).toEqual([]);
    });

    it("should preserve valid capabilities", () => {
      const input: ModelCapabilities = {
        capabilities: ["chat", "vision", "streaming", "reasoning"],
        metadata: { supportsImages: true, hasReasoning: true },
      };

      const result = validateCapabilities(input);

      expect(result.capabilities).toEqual([
        "chat",
        "vision",
        "streaming",
        "reasoning",
      ]);
      expect(result.metadata?.supportsImages).toBe(true);
      expect(result.metadata?.hasReasoning).toBe(true);
    });
  });

  describe("getModelCapabilities", () => {
    it("should return fallback capabilities when OpenRouter API fails", async () => {
      vi.spyOn(global, "fetch").mockRejectedValue(new Error("API failure"));

      const result = await getModelCapabilities("test-model", "openai");

      expect(result.capabilities).toContain("streaming");
      expect(result.capabilities).toContain("chat");
    });

    it("should use validated capabilities from OpenRouter when available", async () => {
      // Mock a successful OpenRouter response
      const mockModel: OpenRouterModel = {
        id: "test-model",
        name: "Test Model",
        created: Date.now(),
        context_length: 128000,
        architecture: {
          modality: "text -> text",
          input_modalities: ["text"],
          output_modalities: ["text"],
          tokenizer: "test-tokenizer",
          instruct_type: null,
        },
      };

      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ data: [mockModel] }),
      } as Response);

      const result = await getModelCapabilities("test-model", "openai");

      expect(result.capabilities).toContain("chat");
      expect(result.capabilities).toContain("streaming");
    });
  });

  describe("clearCapabilitiesCache", () => {
    it("should clear the cache", () => {
      // This is a simple function test
      expect(() => clearCapabilitiesCache()).not.toThrow();
    });
  });

  describe("fetchModelCapabilitiesFromOpenRouter", () => {
    it("should return null when model is not found", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      } as Response);

      const result =
        await fetchModelCapabilitiesFromOpenRouter("non-existent-model");

      expect(result).toBeNull();
    });

    it("should return capabilities when model is found", async () => {
      const mockModel: OpenRouterModel = {
        id: "found-model",
        name: "Found Model",
        created: Date.now(),
        context_length: 128000,
        architecture: {
          modality: "text -> text",
          input_modalities: ["text"],
          output_modalities: ["text"],
          tokenizer: "test-tokenizer",
          instruct_type: null,
        },
      };

      vi.spyOn(global, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ data: [mockModel] }),
      } as Response);

      const result = await fetchModelCapabilitiesFromOpenRouter("found-model");

      expect(result).not.toBeNull();
      expect(result?.capabilities).toContain("chat");
      expect(result?.capabilities).toContain("streaming");
    });

    it("should handle API errors gracefully", async () => {
      vi.spyOn(global, "fetch").mockRejectedValue(new Error("API error"));

      const result = await fetchModelCapabilitiesFromOpenRouter("test-model");

      expect(result).toBeNull();
    });
  });
});
