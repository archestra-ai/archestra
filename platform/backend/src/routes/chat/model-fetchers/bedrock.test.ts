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
  const originalRegion = config.llm.bedrock.region;

  // The fetcher now surfaces embedding models too (tagged with a dimension) and
  // statically injects Titan (which has no inference profile). These chat-model
  // tests filter those out to assert only the chat models a profile listing
  // yields; embedding discovery is covered separately below.
  const chatOnly = (models: Awaited<ReturnType<typeof fetchBedrockModels>>) =>
    models.filter(
      (m) =>
        m.capabilities?.embeddingDimensions == null &&
        !m.capabilities?.supportedEndpoints?.includes("/rerank"),
    );

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch.mockReset();
    config.llm.bedrock.baseUrl =
      "https://bedrock-runtime.us-east-1.amazonaws.com";
  });

  afterEach(() => {
    config.llm.bedrock.baseUrl = originalBaseUrl;
    config.llm.bedrock.region = originalRegion;
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

    expect(chatOnly(models)).toEqual([
      {
        id: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
        displayName: "Claude 3.5 Sonnet v2",
        provider: "bedrock",
      },
    ]);
  });

  test("excludes non-chat models (image, rerank, unsupported embeddings) from the chat picker", async () => {
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

    // Only the text-generation model survives the chat picker; image/video
    // generators, rerank, and not-yet-supported embeddings (cohere.embed,
    // twelvelabs) are dropped so a member can't pick one and break chat. Chat
    // families that merely resemble excluded ones (e.g. nova-lite) must NOT be
    // filtered.
    expect(chatOnly(models).map((model) => model.id)).toEqual([
      "global.anthropic.claude-opus-4-8",
    ]);
    expect(
      models.find((model) => model.id === "cohere.rerank-v3-5:0"),
    ).toMatchObject({
      capabilities: { supportedEndpoints: ["/rerank"] },
    });
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

    expect(chatOnly(models).map((model) => model.id)).toEqual([
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

    expect(chatOnly(models)).toEqual([
      {
        id: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
        displayName: "Claude 3.5 Sonnet v2",
        provider: "bedrock",
        underlyingModelName: "anthropic.claude-3-5-sonnet-20241022-v2:0",
      },
    ]);
  });

  test("calls ListInferenceProfiles and ListFoundationModels with the correct URLs and auth header", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ inferenceProfileSummaries: [] }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ modelSummaries: [] }),
    });

    await fetchBedrockModels("my-api-key");

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [profilesUrl, profilesOptions] = mockFetch.mock.calls[0];
    expect(profilesUrl).toBe(
      "https://bedrock.us-east-1.amazonaws.com/inference-profiles?maxResults=1000",
    );
    expect(profilesOptions.headers.Authorization).toBe("Bearer my-api-key");

    const [modelsUrl, modelsOptions] = mockFetch.mock.calls[1];
    expect(modelsUrl).toBe(
      "https://bedrock.us-east-1.amazonaws.com/foundation-models",
    );
    expect(modelsOptions.headers.Authorization).toBe("Bearer my-api-key");
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

    expect(chatOnly(models).map((model) => model.id)).toEqual([
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

  test("derives the default regional endpoint when baseUrl is not configured", async () => {
    config.llm.bedrock.baseUrl = "";
    config.llm.bedrock.region = "";
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ inferenceProfileSummaries: [] }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ modelSummaries: [] }),
    });

    await expect(fetchBedrockModels("test-api-key")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "amazon.titan-embed-image-v1" }),
      ]),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(
        "https://bedrock.us-east-1.amazonaws.com/inference-profiles",
      ),
      expect.anything(),
    );
  });

  test("keeps static embedding models when inference-profile discovery is denied", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: () =>
        Promise.resolve(
          '{"__type":"AccessDeniedException","message":"denied"}',
        ),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: () => Promise.resolve("Forbidden"),
    });

    const models = await fetchBedrockModels("invoke-only-key");

    expect(models.map((model) => model.id)).toEqual(
      expect.arrayContaining([
        "amazon.titan-embed-image-v1",
        "cohere.embed-english-v3",
      ]),
    );
  });

  test("propagates invalid credentials instead of returning static models", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: () =>
        Promise.resolve(
          '{"__type":"UnrecognizedClientException","message":"bad key"}',
        ),
    });

    await expect(fetchBedrockModels("bad-key")).rejects.toThrow(
      "Failed to fetch Bedrock inference profiles: 403",
    );
  });

  test("propagates transient inference-profile failures", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('{"message":"temporary outage"}'),
    });

    await expect(fetchBedrockModels("test-key")).rejects.toThrow(
      "Failed to fetch Bedrock inference profiles: 500",
    );
  });

  test("propagates a later inference-profile pagination failure", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({ inferenceProfileSummaries: [], nextToken: "page-2" }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: () => Promise.resolve('{"message":"page failed"}'),
    });

    await expect(fetchBedrockModels("test-key")).rejects.toThrow(
      "Failed to fetch Bedrock inference profiles: 503",
    );
  });

  test("injects the Titan embedding models with their dimensions", async () => {
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
          ],
        }),
    });

    const models = await fetchBedrockModels("test-api-key");

    // Titan has no inference profile, so it is statically injected and tagged as
    // an embedding model (a dimension marks it as embedding + excludes it from chat).
    const titanV2 = models.find((m) => m.id === "amazon.titan-embed-text-v2:0");
    expect(titanV2?.capabilities?.embeddingDimensions).toBe(1024);
    const titanV1 = models.find((m) => m.id === "amazon.titan-embed-text-v1");
    expect(titanV1?.capabilities?.embeddingDimensions).toBe(1536);
    const titanImage = models.find(
      (m) => m.id === "amazon.titan-embed-image-v1",
    );
    expect(titanImage?.capabilities?.embeddingDimensions).toBe(1024);
  });

  test("injects the Cohere Embed v3 models by their bare on-demand ids", async () => {
    // AWS publishes NO inference profiles for embedding models (each model
    // card lists Geo/Global inference IDs as "Not supported"), so Cohere never
    // appears in the profile listing — it is statically injected like Titan.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ inferenceProfileSummaries: [] }),
    });

    const models = await fetchBedrockModels("test-api-key");

    const english = models.find((m) => m.id === "cohere.embed-english-v3");
    expect(english?.capabilities?.embeddingDimensions).toBe(1024);
    const multilingual = models.find(
      (m) => m.id === "cohere.embed-multilingual-v3",
    );
    expect(multilingual?.capabilities?.embeddingDimensions).toBe(1024);
  });

  test("drops an application inference profile wrapping an embedding model", async () => {
    // The embedding client dispatches on the configured model id, and an app
    // profile's opaque ARN misses the catalog (only geo prefixes normalize
    // away) — selected, it would take the text path and send the wrong
    // request body. The bare on-demand id stays selectable via static
    // injection, so nothing is lost by dropping the profile.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          inferenceProfileSummaries: [
            {
              inferenceProfileId:
                "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123",
              inferenceProfileName: "Team Cohere Embeddings",
              status: "ACTIVE",
              models: [
                {
                  modelArn:
                    "arn:aws:bedrock:us-east-1::foundation-model/cohere.embed-english-v3",
                },
              ],
            },
          ],
        }),
    });

    const models = await fetchBedrockModels("test-api-key");

    expect(
      models.some((m) => m.id.includes("application-inference-profile")),
    ).toBe(false);
    const bare = models.find((m) => m.id === "cohere.embed-english-v3");
    expect(bare?.capabilities?.embeddingDimensions).toBe(1024);
  });

  test("does not inject embedding models whose vendor is not in the allowed providers", async () => {
    const originalAllowedProviders = config.llm.bedrock.allowedProviders;
    config.llm.bedrock.allowedProviders = ["anthropic"];

    try {
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
            ],
          }),
      });

      const models = await fetchBedrockModels("test-api-key");

      expect(models.some((m) => m.id.startsWith("amazon.titan-embed"))).toBe(
        false,
      );
      expect(models.some((m) => m.id.startsWith("cohere.embed"))).toBe(false);
    } finally {
      config.llm.bedrock.allowedProviders = originalAllowedProviders;
    }
  });

  describe("on-demand foundation models without an inference profile", () => {
    const mockProfiles = (summaries: unknown[]) =>
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ inferenceProfileSummaries: summaries }),
      });
    const mockFoundationModels = (summaries: unknown[]) =>
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ modelSummaries: summaries }),
      });

    test("offers an on-demand chat model that has no inference profile", async () => {
      mockProfiles([]);
      mockFoundationModels([
        {
          modelId: "openai.gpt-oss-120b-1:0",
          modelName: "gpt-oss-120b",
          providerName: "OpenAI",
          outputModalities: ["TEXT"],
          inferenceTypesSupported: ["ON_DEMAND"],
          modelLifecycle: { status: "ACTIVE" },
        },
      ]);

      const models = await fetchBedrockModels("test-api-key");

      const gptOss = models.find((m) => m.id === "openai.gpt-oss-120b-1:0");
      expect(gptOss).toBeDefined();
      expect(gptOss?.displayName).toBe("gpt-oss-120b (OpenAI)");
    });

    test("skips models that are only reachable through an inference profile", async () => {
      mockProfiles([]);
      mockFoundationModels([
        {
          modelId: "anthropic.claude-sonnet-4-20250514-v1:0",
          modelName: "Claude Sonnet 4",
          outputModalities: ["TEXT"],
          inferenceTypesSupported: ["INFERENCE_PROFILE"],
          modelLifecycle: { status: "ACTIVE" },
        },
      ]);

      const models = await fetchBedrockModels("test-api-key");

      // Its bare id is not invocable, and the cross-region profile already
      // represents it in the picker.
      expect(
        models.some((m) => m.id === "anthropic.claude-sonnet-4-20250514-v1:0"),
      ).toBe(false);
    });

    test("skips non-text and legacy models", async () => {
      mockProfiles([]);
      mockFoundationModels([
        {
          modelId: "stability.stable-image-core-v1:1",
          modelName: "Stable Image Core",
          outputModalities: ["IMAGE"],
          inferenceTypesSupported: ["ON_DEMAND"],
          modelLifecycle: { status: "ACTIVE" },
        },
        {
          modelId: "amazon.old-text-model-v1:0",
          modelName: "Retired",
          outputModalities: ["TEXT"],
          inferenceTypesSupported: ["ON_DEMAND"],
          modelLifecycle: { status: "LEGACY" },
        },
      ]);

      const models = await fetchBedrockModels("test-api-key");

      expect(models.some((m) => m.id.startsWith("stability."))).toBe(false);
      expect(models.some((m) => m.id === "amazon.old-text-model-v1:0")).toBe(
        false,
      );
    });

    test("does not duplicate a model the inference-profile listing already returned", async () => {
      mockProfiles([
        {
          inferenceProfileId: "openai.gpt-oss-120b-1:0",
          inferenceProfileName: "gpt-oss-120b",
          status: "ACTIVE",
        },
      ]);
      mockFoundationModels([
        {
          modelId: "openai.gpt-oss-120b-1:0",
          modelName: "gpt-oss-120b",
          outputModalities: ["TEXT"],
          inferenceTypesSupported: ["ON_DEMAND"],
          modelLifecycle: { status: "ACTIVE" },
        },
      ]);

      const models = await fetchBedrockModels("test-api-key");

      expect(
        models.filter((m) => m.id === "openai.gpt-oss-120b-1:0"),
      ).toHaveLength(1);
    });

    test("honors the operator's provider allowlist", async () => {
      const originalAllowedProviders = config.llm.bedrock.allowedProviders;
      config.llm.bedrock.allowedProviders = ["anthropic"];

      try {
        mockProfiles([]);
        mockFoundationModels([
          {
            modelId: "openai.gpt-oss-120b-1:0",
            modelName: "gpt-oss-120b",
            outputModalities: ["TEXT"],
            inferenceTypesSupported: ["ON_DEMAND"],
            modelLifecycle: { status: "ACTIVE" },
          },
        ]);

        const models = await fetchBedrockModels("test-api-key");

        expect(models.some((m) => m.id.startsWith("openai."))).toBe(false);
      } finally {
        config.llm.bedrock.allowedProviders = originalAllowedProviders;
      }
    });

    test("keeps the profile-derived models when listing foundation models is denied", async () => {
      mockProfiles([
        {
          inferenceProfileId: "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
          inferenceProfileName: "Claude 3.5 Sonnet v2",
          status: "ACTIVE",
        },
      ]);
      // A credential without bedrock:ListFoundationModels must not break sync.
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: () => Promise.resolve("AccessDeniedException"),
      });

      const models = await fetchBedrockModels("test-api-key");

      expect(
        models.some(
          (m) => m.id === "us.anthropic.claude-3-5-sonnet-20241022-v2:0",
        ),
      ).toBe(true);
    });
  });
});
