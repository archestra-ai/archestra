import type { GoogleGenAI } from "@google/genai";
import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";
import { fetchGeminiModels, fetchGeminiModelsViaVertexAi } from "./gemini";

const mockFetch = vi.fn();
global.fetch = mockFetch;

vi.mock("@/clients/gemini-client", () => ({
  createGoogleGenAIClient: vi.fn(),
}));

import { createGoogleGenAIClient } from "@/clients/gemini-client";

const mockCreateGoogleGenAIClient = vi.mocked(createGoogleGenAIClient);

describe("gemini model fetchers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  describe("fetchGeminiModels", () => {
    test("keeps usable Gemini-family chat + embedding models and drops the rest", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            models: [
              {
                name: "models/gemini-2.5-pro",
                displayName: "Gemini 2.5 Pro",
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/gemini-1.5-pro",
                displayName: "Gemini 1.5 Pro",
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/gemini-2.5-flash-preview-tts",
                displayName: "Gemini 2.5 Flash TTS",
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/gemma-3-27b-it",
                displayName: "Gemma 3 27B",
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/gemma-2-9b-it",
                displayName: "Gemma 2 9B",
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/gemini-embedding-001",
                displayName: "Gemini Embedding 001",
                supportedGenerationMethods: [
                  "embedContent",
                  "batchEmbedContents",
                ],
              },
              {
                name: "models/aqa",
                displayName: "AQA",
                supportedGenerationMethods: ["generateAnswer"],
              },
              {
                name: "models/learnlm-2.0-flash-experimental",
                displayName: "LearnLM 2.0 Flash",
                supportedGenerationMethods: ["generateContent"],
              },
            ],
          }),
      });

      const models = await fetchGeminiModels("test-api-key");

      expect(models).toEqual([
        {
          id: "gemini-2.5-pro",
          displayName: "Gemini 2.5 Pro",
          provider: "gemini",
        },
        {
          id: "gemma-3-27b-it",
          displayName: "Gemma 3 27B",
          provider: "gemini",
        },
        {
          id: "gemini-embedding-001",
          displayName: "Gemini Embedding 001",
          provider: "gemini",
        },
      ]);
    });

    test("includes embedding models that only advertise batchEmbedContents", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            models: [
              {
                name: "models/gemini-embedding-exp-03-07",
                displayName: "Gemini Embedding Experimental",
                supportedGenerationMethods: ["batchEmbedContents"],
              },
            ],
          }),
      });

      const models = await fetchGeminiModels("test-api-key");

      expect(models).toEqual([
        {
          id: "gemini-embedding-exp-03-07",
          displayName: "Gemini Embedding Experimental",
          provider: "gemini",
        },
      ]);
    });

    test("throws error on API failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: () => Promise.resolve("Invalid API key"),
      });

      await expect(fetchGeminiModels("invalid-key")).rejects.toThrow(
        "Failed to fetch Gemini models: 401",
      );
    });
  });

  describe("fetchGeminiModelsViaVertexAi", () => {
    test("fetches Gemini catalog entries using Vertex AI SDK format", async () => {
      const mockModels = [
        {
          name: "publishers/google/models/gemini-2.5-pro",
          version: "default",
          tunedModelInfo: {},
        },
        {
          name: "publishers/google/models/gemini-2.5-flash",
          version: "default",
          tunedModelInfo: {},
        },
        {
          name: "publishers/google/models/gemini-embedding-001",
          version: "default",
          tunedModelInfo: {},
        },
        {
          name: "publishers/google/models/gemma-3-27b-it",
          version: "default",
          tunedModelInfo: {},
        },
        {
          name: "publishers/google/models/gemini-1.5-pro-002",
          version: "002",
          tunedModelInfo: {},
        },
        {
          name: "publishers/google/models/imageclassification-efficientnet",
          version: "001",
          tunedModelInfo: {},
        },
      ];

      const mockPager = {
        [Symbol.asyncIterator]: async function* () {
          for (const model of mockModels) {
            yield model;
          }
        },
      };

      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue(mockPager),
          get: vi.fn(),
        },
      } as unknown as GoogleGenAI;

      mockCreateGoogleGenAIClient.mockReturnValue(mockClient);

      const models = await fetchGeminiModelsViaVertexAi();

      expect(models).toEqual([
        {
          id: "gemini-2.5-pro",
          displayName: "Gemini 2.5 Pro",
          provider: "gemini",
        },
        {
          id: "gemini-2.5-flash",
          displayName: "Gemini 2.5 Flash",
          provider: "gemini",
        },
        {
          id: "gemini-embedding-001",
          displayName: "Gemini Embedding 001",
          provider: "gemini",
        },
        {
          id: "gemma-3-27b-it",
          displayName: "Gemma 3 27b It",
          provider: "gemini",
        },
      ]);
      expect(mockClient.models.get).not.toHaveBeenCalled();
    });

    test("falls back to probing known Gemini model IDs when list is incomplete", async () => {
      const mockPager = {
        [Symbol.asyncIterator]: async function* () {
          yield {
            name: "publishers/google/models/text-embedding-005",
            version: "default",
            tunedModelInfo: {},
          };
        },
      };

      const mockGet = vi.fn(async ({ model }: { model: string }) => {
        if (model === "gemini-embedding-001") {
          return {
            name: "publishers/google/models/gemini-embedding-001",
            displayName: "Gemini Embedding 001",
          };
        }

        if (model === "gemini-embedding-2-preview") {
          return {
            name: "publishers/google/models/gemini-embedding-2-preview",
            displayName: "Gemini Embedding 2 Preview",
          };
        }

        if (model === "gemini-2.5-flash") {
          return {
            name: "publishers/google/models/gemini-2.5-flash",
            displayName: "Gemini 2.5 Flash",
          };
        }

        if (model === "gemini-2.5-pro") {
          return {
            name: "publishers/google/models/gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
          };
        }

        throw new Error("Not found");
      });

      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue(mockPager),
          get: mockGet,
        },
      } as unknown as GoogleGenAI;

      mockCreateGoogleGenAIClient.mockReturnValue(mockClient);

      const models = await fetchGeminiModelsViaVertexAi();

      expect(models).toEqual([
        {
          id: "gemini-embedding-001",
          displayName: "Gemini Embedding 001",
          provider: "gemini",
        },
        {
          id: "gemini-embedding-2-preview",
          displayName: "Gemini Embedding 2 Preview",
          provider: "gemini",
        },
        {
          id: "gemini-2.5-pro",
          displayName: "Gemini 2.5 Pro",
          provider: "gemini",
        },
        {
          id: "gemini-2.5-flash",
          displayName: "Gemini 2.5 Flash",
          provider: "gemini",
        },
      ]);
    });

    test("drops non-text Gemini from the list and merges usable fallback models", async () => {
      const mockPager = {
        [Symbol.asyncIterator]: async function* () {
          yield {
            name: "publishers/google/models/gemini-live-2.5-flash-native-audio",
            version: "default",
            tunedModelInfo: {},
          };
        },
      };

      const mockGet = vi.fn(async ({ model }: { model: string }) => {
        if (
          model === "gemini-embedding-001" ||
          model === "gemini-embedding-2-preview" ||
          model === "gemini-2.5-pro" ||
          model === "gemini-2.5-flash" ||
          model === "gemini-2.5-flash-lite"
        ) {
          return {
            name: `publishers/google/models/${model}`,
            displayName: null,
          };
        }

        throw new Error("Not found");
      });

      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue(mockPager),
          get: mockGet,
        },
      } as unknown as GoogleGenAI;

      mockCreateGoogleGenAIClient.mockReturnValue(mockClient);

      const models = await fetchGeminiModelsViaVertexAi();

      // The live/audio model is filtered out entirely; only usable fallback
      // models remain.
      expect(models).toEqual([
        {
          id: "gemini-embedding-001",
          displayName: "Gemini Embedding 001",
          provider: "gemini",
        },
        {
          id: "gemini-embedding-2-preview",
          displayName: "Gemini Embedding 2 Preview",
          provider: "gemini",
        },
        {
          id: "gemini-2.5-pro",
          displayName: "Gemini 2.5 Pro",
          provider: "gemini",
        },
        {
          id: "gemini-2.5-flash",
          displayName: "Gemini 2.5 Flash",
          provider: "gemini",
        },
        {
          id: "gemini-2.5-flash-lite",
          displayName: "Gemini 2.5 Flash Lite",
          provider: "gemini",
        },
      ]);
    });
  });
});
