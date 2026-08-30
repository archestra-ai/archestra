import type OpenAIProvider from "openai";
import { vi } from "vitest";
import config from "@/config";
import { describe, expect, test } from "@/test";

vi.mock("@/observability");

vi.mock("@/clients/azure-openai-credentials", () => ({
  getAzureOpenAiBearerTokenProvider: vi.fn(() => async () => "entra-token"),
  isAzureOpenAiEntraIdEnabled: vi.fn(() => false),
}));

import {
  getAzureOpenAiBearerTokenProvider,
  isAzureOpenAiEntraIdEnabled,
} from "@/clients/azure-openai-credentials";
import { azureAdapterFactory } from "./azure";

type TestAzureClient = {
  openai: OpenAIProvider & {
    _options?: {
      apiKey?: unknown;
      baseURL?: string;
      defaultHeaders?: Record<string, string>;
      defaultQuery?: Record<string, string>;
    };
  };
};

const mockIsAzureOpenAiEntraIdEnabled = vi.mocked(isAzureOpenAiEntraIdEnabled);
const mockGetAzureOpenAiBearerTokenProvider = vi.mocked(
  getAzureOpenAiBearerTokenProvider,
);

describe("azureAdapterFactory", () => {
  describe("extractApiKey", () => {
    test("returns authorization header value", () => {
      const result = azureAdapterFactory.extractApiKey({
        authorization: "Bearer my-azure-key",
      });
      expect(result).toBe("Bearer my-azure-key");
    });

    test("returns undefined when authorization header is absent", () => {
      const result = azureAdapterFactory.extractApiKey({
        authorization: undefined as unknown as string,
      });
      expect(result).toBeUndefined();
    });
  });

  describe("getBaseUrl", () => {
    test("returns the configured Azure endpoint", () => {
      config.llm.azure.baseUrl =
        "https://configured-resource.openai.azure.com/openai";

      expect(azureAdapterFactory.getBaseUrl()).toBe(
        "https://configured-resource.openai.azure.com/openai",
      );
    });
  });

  describe("createClient", () => {
    test("uses an Entra ID token provider when enabled and no apiKey is provided", () => {
      mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(true);

      const client = azureAdapterFactory.createClient(undefined, {
        baseUrl:
          "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
        defaultHeaders: {},
        source: "api",
      }) as TestAzureClient;

      expect(typeof client.openai._options?.apiKey).toBe("function");
      expect(
        client.openai._options?.defaultHeaders?.["api-key"],
      ).toBeUndefined();
      expect(mockGetAzureOpenAiBearerTokenProvider).toHaveBeenCalledWith(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
      );

      mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);
    });

    test("omits api-version for Azure OpenAI v1 base URLs", () => {
      mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(true);

      const client = azureAdapterFactory.createClient(undefined, {
        baseUrl: "https://my-resource.services.ai.azure.com/openai/v1",
        defaultHeaders: {},
        source: "api",
      }) as TestAzureClient;

      expect(client.openai._options?.defaultQuery).toBeUndefined();
      expect(mockGetAzureOpenAiBearerTokenProvider).toHaveBeenCalledWith(
        "https://my-resource.services.ai.azure.com/openai/v1",
      );

      mockIsAzureOpenAiEntraIdEnabled.mockReturnValue(false);
    });

    test("throws ApiError(401) when apiKey is undefined", () => {
      expect(() =>
        azureAdapterFactory.createClient(undefined, {
          baseUrl:
            "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
          defaultHeaders: {},
          source: "api",
        }),
      ).toThrow("API key required for Azure AI Foundry");
    });

    test("returns a client when apiKey is provided", () => {
      const client = azureAdapterFactory.createClient("my-azure-key", {
        baseUrl:
          "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
        defaultHeaders: {},
        source: "api",
      });
      expect(client).toBeDefined();
    });

    test("sets api-key header without the Bearer prefix", () => {
      const client = azureAdapterFactory.createClient("Bearer my-azure-key", {
        baseUrl:
          "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
        defaultHeaders: {},
        source: "api",
      }) as TestAzureClient;

      expect(client.openai._options?.defaultHeaders?.["api-key"]).toBe(
        "my-azure-key",
      );
      expect(client.openai._options?.apiKey).toBe("my-azure-key");
    });

    test("preserves the original key when no Bearer prefix is present", () => {
      const client = azureAdapterFactory.createClient("my-azure-key", {
        baseUrl:
          "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
        defaultHeaders: {},
        source: "api",
      }) as TestAzureClient;

      expect(client.openai._options?.defaultHeaders?.["api-key"]).toBe(
        "my-azure-key",
      );
      expect(client.openai._options?.apiKey).toBe("my-azure-key");
    });

    test("stores resource-level base URL for per-request deployment routing", () => {
      const client = azureAdapterFactory.createClient("my-azure-key", {
        baseUrl: "https://my-resource.openai.azure.com/openai",
        defaultHeaders: {},
        source: "api",
      }) as TestAzureClient & { baseUrl?: string };

      expect(client.baseUrl).toBe(
        "https://my-resource.openai.azure.com/openai",
      );
      expect(client.openai._options?.baseURL).toBe(
        "https://my-resource.openai.azure.com/openai",
      );
    });
  });

  describe("extractErrorMessage", () => {
    test("extracts Azure-specific nested error message", () => {
      const azureError = { error: { message: "DeploymentNotFound" } };
      expect(azureAdapterFactory.extractErrorMessage(azureError)).toBe(
        "DeploymentNotFound",
      );
    });

    test("falls back to Error.message for generic errors", () => {
      const err = new Error("Network timeout");
      expect(azureAdapterFactory.extractErrorMessage(err)).toBe(
        "Network timeout",
      );
    });

    test("falls back to internal server error for unknown shapes", () => {
      expect(azureAdapterFactory.extractErrorMessage(42)).toBe(
        "Internal server error",
      );
    });

    test("falls back to internal server error for null", () => {
      expect(azureAdapterFactory.extractErrorMessage(null)).toBe(
        "Internal server error",
      );
    });
  });

  describe("createStreamAdapter", () => {
    // The azure stream adapter delegates to OpenAIStreamAdapter; this pins that
    // the delegation covers reasoning forwarding — Foundry-hosted reasoning
    // models (DeepSeek-R1, gpt-oss, ...) stream thinking in `reasoning_content`
    // deltas that must reach streaming clients unmodified.
    test("forwards a reasoning-only chunk (reasoning_content) instead of dropping it", () => {
      const adapter = azureAdapterFactory.createStreamAdapter();
      const result = adapter.processChunk({
        id: "chatcmpl-r",
        object: "chat.completion.chunk",
        created: 0,
        model: "DeepSeek-R1",
        choices: [
          {
            index: 0,
            delta: { reasoning_content: "Let me think..." },
            finish_reason: null,
          },
        ],
      } as unknown as Parameters<typeof adapter.processChunk>[0]);

      expect(result.sseData).not.toBeNull();
      const text =
        typeof result.sseData === "string"
          ? result.sseData
          : new TextDecoder().decode(result.sseData as Uint8Array);
      const delta = (
        JSON.parse(text.replace(/^data: /, "").trim()) as {
          choices: Array<{ delta: Record<string, unknown> }>;
        }
      ).choices[0].delta;
      expect(delta).toMatchObject({ reasoning_content: "Let me think..." });
    });
  });
});
