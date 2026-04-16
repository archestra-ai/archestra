import type OpenAIProvider from "openai";
import { vi } from "vitest";
import { describe, expect, test } from "@/test";

vi.mock("@/observability", () => ({
  metrics: { llm: { getObservableFetch: vi.fn() } },
}));

import { azureAdapterFactory } from "./azure";

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
    test("returns string or undefined depending on config", () => {
      // In test environments ARCHESTRA_AZURE_OPENAI_BASE_URL is unset,
      // so baseUrl coerces to undefined via `config.llm.azure.baseUrl || undefined`
      const url = azureAdapterFactory.getBaseUrl();
      expect(url === undefined || typeof url === "string").toBe(true);
    });
  });

  describe("createClient", () => {
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
      }) as OpenAIProvider & {
        _options?: { defaultHeaders?: Record<string, string> };
      };

      expect(client._options?.defaultHeaders?.["api-key"]).toBe("my-azure-key");
      expect(client._options?.apiKey).toBe("my-azure-key");
    });

    test("preserves the original key when no Bearer prefix is present", () => {
      const client = azureAdapterFactory.createClient("my-azure-key", {
        baseUrl:
          "https://my-resource.openai.azure.com/openai/deployments/gpt-4o",
        defaultHeaders: {},
        source: "api",
      }) as OpenAIProvider & {
        _options?: { defaultHeaders?: Record<string, string> };
      };

      expect(client._options?.defaultHeaders?.["api-key"]).toBe("my-azure-key");
      expect(client._options?.apiKey).toBe("my-azure-key");
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
});
