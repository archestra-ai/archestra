```typescript
import type { GoogleGenAI } from "@google/genai";
import { vi } from "vitest";
import config from "@/config";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  fetchBedrockModels,
  fetchGeminiModels,
  fetchGeminiModelsViaVertexAi,
  fetchModelsForProvider,
  mapOpenAiModelToModelInfo,
  testProviderApiKey,
} from "./routes.models";

// ... existing code

describe("fetchXaiGrokModels", () => {
  test("fetches and filters x.ai (Grok) models that support generateContent", async () => {
    const mockResponse = {
      data: [
        {
          id: "model-1",
          display_name: "Model 1",
          created_at: "2023-06-01T00:00:00.000Z",
        },
        {
          id: "model-2",
          display_name: "Model 2",
          created_at: "2023-06-01T00:00:00.000Z",
        },
      ],
    };

    const fetchSpy = vi.spyOn(global, "fetch");
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    });

    const models = await fetchXaiGrokModels("api-key");
    expect(models).toEqual([
      {
        id: "model-1",
        displayName: "Model 1",
        provider: "xai-grok",
        createdAt: "2023-06-01T00:00:00.000Z",
      },
      {
        id: "model-2",
        displayName: "Model 2",
        provider: "xai-grok",
        createdAt: "2023-06-01T00:00:00.000Z",
      },
    ]);

    fetchSpy.mockRestore();
  });
});