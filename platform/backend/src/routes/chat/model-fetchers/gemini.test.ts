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
    test("fetches Gemini models that support generateContent or embedContent", async () => {
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
                name: "models/gemini-2.5-flash",
                displayName: "Gemini 2.5 Flash",
                supportedGenerationMethods: ["generateContent", "countTokens"],
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
          id: "gemini-2.5-flash",
          displayName: "Gemini 2.5 Flash",
          provider: "gemini",
        },
        {
          id: "gemini-embedding-001",
          displayName: "Gemini Embedding 001",
          provider: "gemini",
        },
      ]);
    });

    test("includes Gemini models that only advertise batchEmbedContents", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            models: [
              {
                name: "models/gemini-batch-embedding-only",
                displayName: "Gemini Batch Embedding Only",
                supportedGenerationMethods: ["batchEmbedContents"],
              },
            ],
          }),
      });

      const models = await fetchGeminiModels("test-api-key");

      expect(models).toEqual([
        {
          id: "gemini-batch-embedding-only",
          displayName: "Gemini Batch Embedding Only",
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

    test("merges fallback models when list only returns live audio Gemini", async () => {
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
          model === "gemini-2.5-pro" ||
          model === "gemini-2.5-flash" ||
          model === "gemini-2.5-flash-lite" ||
          model === "gemini-2.0-flash-001" ||
          model === "gemini-2.0-flash-lite-001"
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

      expect(models).toEqual([
        {
          id: "gemini-live-2.5-flash-native-audio",
          displayName: "Gemini Live 2.5 Flash Native Audio",
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
        {
          id: "gemini-2.0-flash-001",
          displayName: "Gemini 2.0 Flash 001",
          provider: "gemini",
        },
        {
          id: "gemini-2.0-flash-lite-001",
          displayName: "Gemini 2.0 Flash Lite 001",
          provider: "gemini",
        },
      ]);
    });
  });
});
