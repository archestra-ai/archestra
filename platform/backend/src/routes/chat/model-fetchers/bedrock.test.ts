import { vi } from "vitest";
import config from "@/config";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { fetchBedrockModels } from "./bedrock";

const mockFetch = vi.fn();
// The shared test setup restores the real fetch after every test, so
// re-apply the mock before each one.
vi.stubGlobal("fetch", mockFetch);
beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
});

describe("fetchBedrockModels", () => {
  const originalBaseUrl = config.llm.bedrock.baseUrl;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    config.llm.bedrock.baseUrl =
      "https://bedrock-runtime.us-east-1.amazonaws.com";
  });

  afterEach(() => {
    config.llm.bedrock.baseUrl = originalBaseUrl;
  });

  test("returns only ACTIVE inference profiles", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          inferenceProfileSummaries: [
            {
              inferenceProfileId:
                "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
              inferenceProfileName: "Claude 3.5 Sonnet v2",
              status: "ACTIVE",
            },
            {
              inferenceProfileId: "us.anthropic.claude-3-haiku-20240307-v1:0",
              inferenceProfileName: "Claude 3 Haiku",
              status: "INACTIVE",
            },
          ],
        }),
    });

    const models = await fetchBedrockModels("test-api-key");

    expect(models).toEqual([
      {
        id: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
        displayName: "Claude 3.5 Sonnet v2",
        provider: "bedrock",
      },
    ]);
  });

  test("excludes non-chat models (embeddings, image, rerank) from the chat picker", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          inferenceProfileSummaries: [
            {
              inferenceProfileId: "global.anthropic.claude-opus-4-8",
              inferenceProfileName: "Claude Opus 4.8",
              status: "ACTIVE",
            },
            {
              inferenceProfileId: "global.cohere.embed-v4:0",
              inferenceProfileName: "Cohere Embed v4",
              status: "ACTIVE",
            },
            {
              inferenceProfileId: "us.twelvelabs.marengo-embed-3-0-v1:0",
              inferenceProfileName: "Marengo Embed 3.0",
              status: "ACTIVE",
            },
            {
              inferenceProfileId: "us.stability.stable-image-inpaint-v1:0",
              inferenceProfileName: "Stable Image Inpaint",
              status: "ACTIVE",
            },
            {
              inferenceProfileId: "us.amazon.nova-canvas-v1:0",
              inferenceProfileName: "Nova Canvas",
              status: "ACTIVE",
            },
            {
              inferenceProfileId: "us.amazon.nova-reel-v1:1",
              inferenceProfileName: "Nova Reel",
              status: "ACTIVE",
            },
            {
              inferenceProfileId: "cohere.rerank-v3-5:0",
              inferenceProfileName: "Cohere Rerank 3.5",
              status: "ACTIVE",
            },
          ],
        }),
    });

    const models = await fetchBedrockModels("test-api-key");

    // Only the text-generation model survives; embeddings, image/video
    // generators, and rerank are dropped so a member can't pick one and break
    // chat. Chat families that merely resemble excluded ones (e.g. nova-lite)
    // must NOT be filtered.
    expect(models.map((model) => model.id)).toEqual([
      "global.anthropic.claude-opus-4-8",
    ]);
  });

  test("keeps text-generation models whose names resemble non-chat families", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          inferenceProfileSummaries: [
            {
              inferenceProfileId: "us.amazon.nova-lite-v1:0",
              inferenceProfileName: "Nova Lite",
              status: "ACTIVE",
            },
            {
              inferenceProfileId: "us.amazon.titan-text-express-v1",
              inferenceProfileName: "Titan Text Express",
              status: "ACTIVE",
            },
            {
              inferenceProfileId: "us.cohere.command-r-plus-v1:0",
              inferenceProfileName: "Command R+",
              status: "ACTIVE",
            },
          ],
        }),
    });

    const models = await fetchBedrockModels("test-api-key");

    expect(models.map((model) => model.id)).toEqual([
      "us.amazon.nova-lite-v1:0",
      "us.amazon.titan-text-express-v1",
      "us.cohere.command-r-plus-v1:0",
    ]);
  });

  test("captures the foundation-model id from the profile's model ARN for pricing", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          inferenceProfileSummaries: [
            {
              inferenceProfileId:
                "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
              inferenceProfileName: "Claude 3.5 Sonnet v2",
              status: "ACTIVE",
              models: [
                {
                  modelArn:
                    "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-5-sonnet-20241022-v2:0",
                },
              ],
            },
          ],
        }),
    });

    const models = await fetchBedrockModels("test-api-key");

    expect(models).toEqual([
      {
        id: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
        displayName: "Claude 3.5 Sonnet v2",
        provider: "bedrock",
        underlyingModelName: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      },
    ]);
  });

  test("calls ListInferenceProfiles with the correct URL and auth header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ inferenceProfileSummaries: [] }),
    });

    await fetchBedrockModels("my-api-key");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(
      "https://bedrock.us-east-1.amazonaws.com/inference-profiles?maxResults=1000",
    );
    expect(options.headers.Authorization).toBe("Bearer my-api-key");
  });

  test("handles pagination with nextToken", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            inferenceProfileSummaries: [
              {
                inferenceProfileId: "us.anthropic.claude-3-sonnet",
                inferenceProfileName: "Claude 3 Sonnet",
                status: "ACTIVE",
              },
            ],
            nextToken: "page2token",
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            inferenceProfileSummaries: [
              {
                inferenceProfileId: "us.anthropic.claude-3-haiku",
                inferenceProfileName: "Claude 3 Haiku",
                status: "ACTIVE",
              },
            ],
          }),
      });

    const models = await fetchBedrockModels("test-api-key");

    expect(models.map((model) => model.id)).toEqual([
      "us.anthropic.claude-3-sonnet",
      "us.anthropic.claude-3-haiku",
    ]);
    expect(mockFetch.mock.calls[1][0]).toContain("nextToken=page2token");
  });

  test("filters by allowed providers and regions", async () => {
    const originalAllowedProviders = config.llm.bedrock.allowedProviders;
    const originalAllowedRegions = config.llm.bedrock.allowedInferenceRegions;

    config.llm.bedrock.allowedProviders = ["anthropic"];
    config.llm.bedrock.allowedInferenceRegions = ["us", "global"];

    try {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            inferenceProfileSummaries: [
              {
                inferenceProfileId:
                  "global.anthropic.claude-sonnet-4-6-20250514-v1:0",
                inferenceProfileName: "Claude Sonnet 4.6",
                status: "ACTIVE",
              },
              {
                inferenceProfileId:
                  "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
                inferenceProfileName: "Claude 3.5 Sonnet v2",
                status: "ACTIVE",
              },
              {
                inferenceProfileId: "eu.meta.llama3-70b-instruct-v1:0",
                inferenceProfileName: "Llama 3 70B",
                status: "ACTIVE",
              },
            ],
          }),
      });

      const models = await fetchBedrockModels("test-api-key");

      expect(models.map((model) => model.id)).toEqual([
        "global.anthropic.claude-sonnet-4-6-20250514-v1:0",
        "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
      ]);
    } finally {
      config.llm.bedrock.allowedProviders = originalAllowedProviders;
      config.llm.bedrock.allowedInferenceRegions = originalAllowedRegions;
    }
  });

  test("throws error when baseUrl is not configured", async () => {
    config.llm.bedrock.baseUrl = "";

    await expect(fetchBedrockModels("test-api-key")).rejects.toThrow(
      "Bedrock base URL not configured",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("throws error on API failure", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: () => Promise.resolve("Forbidden"),
    });

    await expect(fetchBedrockModels("bad-key")).rejects.toThrow(
      "Failed to fetch Bedrock inference profiles: 403",
    );
  });
});
