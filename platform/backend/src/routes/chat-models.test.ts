import type { GoogleGenAI } from "@google/genai";
import { vi } from "vitest";
import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import { fetchGeminiModels, fetchGeminiModelsViaVertexAi } from "./chat-models";

// Mock fetch globally for testing API calls
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock the Google GenAI client for Vertex AI tests
vi.mock("@/routes/proxy/utils/gemini-client", () => ({
  createGoogleGenAIClient: vi.fn(),
  isVertexAiEnabled: vi.fn(),
}));

import {
  createGoogleGenAIClient,
  isVertexAiEnabled,
} from "@/routes/proxy/utils/gemini-client";

const mockCreateGoogleGenAIClient = vi.mocked(createGoogleGenAIClient);
const mockIsVertexAiEnabled = vi.mocked(isVertexAiEnabled);

describe("chat-models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  describe("fetchGeminiModels (API key mode)", () => {
    test("fetches and filters Gemini models that support generateContent", async () => {
      const mockResponse = {
        models: [
          {
            name: "models/gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
            supportedGenerationMethods: [
              "generateContent",
              "countTokens",
              "createCachedContent",
            ],
          },
          {
            name: "models/gemini-2.5-flash",
            displayName: "Gemini 2.5 Flash",
            supportedGenerationMethods: ["generateContent", "countTokens"],
          },
          {
            name: "models/embedding-001",
            displayName: "Text Embedding",
            supportedGenerationMethods: ["embedContent"],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const models = await fetchGeminiModels("test-api-key");

      expect(models).toHaveLength(2);
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

      // Verify fetch was called with correct URL
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fetchUrl = mockFetch.mock.calls[0][0];
      expect(fetchUrl).toContain("/v1beta/models");
      expect(fetchUrl).toContain("key=test-api-key");
      expect(fetchUrl).toContain("pageSize=100");
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

    test("returns empty array when no models support generateContent", async () => {
      const mockResponse = {
        models: [
          {
            name: "models/embedding-001",
            displayName: "Text Embedding",
            supportedGenerationMethods: ["embedContent"],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const models = await fetchGeminiModels("test-api-key");
      expect(models).toHaveLength(0);
    });

    test("handles models without supportedGenerationMethods field", async () => {
      const mockResponse = {
        models: [
          {
            name: "models/gemini-old",
            displayName: "Old Gemini",
            // No supportedGenerationMethods field
          },
          {
            name: "models/gemini-new",
            displayName: "New Gemini",
            supportedGenerationMethods: ["generateContent"],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const models = await fetchGeminiModels("test-api-key");

      // Only the model with generateContent support should be returned
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe("gemini-new");
    });
  });

  describe("fetchGeminiModelsViaVertexAi", () => {
    test("fetches models using Google GenAI SDK with Vertex AI", async () => {
      // Mock the SDK's models.list() method
      const mockModels: Array<{
        name: string;
        displayName: string;
        supportedActions: string[];
      }> = [
        {
          name: "models/gemini-2.5-pro",
          displayName: "Gemini 2.5 Pro",
          supportedActions: ["generateContent", "countTokens"],
        },
        {
          name: "models/gemini-2.5-flash",
          displayName: "Gemini 2.5 Flash",
          supportedActions: ["generateContent"],
        },
        {
          name: "models/embedding-001",
          displayName: "Embedding Model",
          supportedActions: ["embedContent"],
        },
      ];

      // Create async iterator from mock models
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
        },
      } as unknown as GoogleGenAI;

      mockCreateGoogleGenAIClient.mockReturnValue(mockClient);

      const models = await fetchGeminiModelsViaVertexAi();

      expect(models).toHaveLength(2);
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

      // Verify SDK was called correctly
      expect(mockCreateGoogleGenAIClient).toHaveBeenCalledWith(
        undefined,
        "[ChatModels]",
      );
      expect(mockClient.models.list).toHaveBeenCalledWith({
        config: { pageSize: 100 },
      });
    });

    test("handles models with missing name or displayName", async () => {
      const mockModels = [
        {
          name: "models/gemini-complete",
          displayName: "Complete Model",
          supportedActions: ["generateContent"],
        },
        {
          name: undefined,
          displayName: "No Name Model",
          supportedActions: ["generateContent"],
        },
        {
          name: "models/no-display",
          displayName: undefined,
          supportedActions: ["generateContent"],
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
        },
      } as unknown as GoogleGenAI;

      mockCreateGoogleGenAIClient.mockReturnValue(mockClient);

      const models = await fetchGeminiModelsViaVertexAi();

      expect(models).toHaveLength(3);
      // First model has both name and displayName
      expect(models[0]).toEqual({
        id: "gemini-complete",
        displayName: "Complete Model",
        provider: "gemini",
      });
      // Second model has no name - should have empty id and use displayName
      expect(models[1].id).toBe("");
      // Third model has no displayName - should use id as displayName
      expect(models[2]).toEqual({
        id: "no-display",
        displayName: "no-display",
        provider: "gemini",
      });
    });

    test("handles models with missing supportedActions", async () => {
      const mockModels = [
        {
          name: "models/gemini-with-actions",
          displayName: "With Actions",
          supportedActions: ["generateContent"],
        },
        {
          name: "models/gemini-no-actions",
          displayName: "No Actions",
          // No supportedActions field
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
        },
      } as unknown as GoogleGenAI;

      mockCreateGoogleGenAIClient.mockReturnValue(mockClient);

      const models = await fetchGeminiModelsViaVertexAi();

      // Only the model with generateContent action should be included
      expect(models).toHaveLength(1);
      expect(models[0].id).toBe("gemini-with-actions");
    });

    test("returns empty array when SDK returns no models", async () => {
      const mockPager = {
        [Symbol.asyncIterator]: async function* () {
          // Empty generator
        },
      };

      const mockClient = {
        models: {
          list: vi.fn().mockResolvedValue(mockPager),
        },
      } as unknown as GoogleGenAI;

      mockCreateGoogleGenAIClient.mockReturnValue(mockClient);

      const models = await fetchGeminiModelsViaVertexAi();
      expect(models).toHaveLength(0);
    });
  });

  describe("isVertexAiEnabled", () => {
    test("returns true when Vertex AI is enabled in config", () => {
      const originalEnabled = config.llm.gemini.vertexAi.enabled;

      try {
        config.llm.gemini.vertexAi.enabled = true;
        mockIsVertexAiEnabled.mockReturnValue(true);

        expect(mockIsVertexAiEnabled()).toBe(true);
      } finally {
        config.llm.gemini.vertexAi.enabled = originalEnabled;
      }
    });

    test("returns false when Vertex AI is disabled in config", () => {
      const originalEnabled = config.llm.gemini.vertexAi.enabled;

      try {
        config.llm.gemini.vertexAi.enabled = false;
        mockIsVertexAiEnabled.mockReturnValue(false);

        expect(mockIsVertexAiEnabled()).toBe(false);
      } finally {
        config.llm.gemini.vertexAi.enabled = originalEnabled;
      }
    });
  });
});
