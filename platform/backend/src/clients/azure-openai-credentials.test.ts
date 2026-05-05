import { describe, expect, test, vi } from "vitest";

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: vi.fn(function DefaultAzureCredential() {
    return { kind: "default" };
  }),
  getBearerTokenProvider: vi.fn(() => async () => "token"),
}));

vi.mock("@/config", () => ({
  default: {
    llm: {
      azure: {
        entraIdEnabled: true,
      },
      anthropic: {
        azureFoundryEntraIdEnabled: true,
      },
    },
  },
}));

import { getBearerTokenProvider } from "@azure/identity";
import {
  getAzureAiFoundryBearerTokenProvider,
  getAzureOpenAiBearerTokenProvider,
  isAnthropicAzureFoundryEntraIdEnabled,
  isAzureOpenAiEntraIdEnabled,
} from "./azure-openai-credentials";

describe("azure-openai-credentials", () => {
  test("reports Entra ID auth as enabled from config", () => {
    expect(isAzureOpenAiEntraIdEnabled()).toBe(true);
    expect(isAnthropicAzureFoundryEntraIdEnabled()).toBe(true);
  });

  test("creates a cached bearer token provider with the Azure OpenAI scope", () => {
    const provider = getAzureOpenAiBearerTokenProvider(
      "https://resource.openai.azure.com/openai/deployments/gpt-4o",
    );
    const sameProvider = getAzureOpenAiBearerTokenProvider(
      "https://resource.openai.azure.com/openai/deployments/gpt-4o",
    );

    expect(provider).toBe(sameProvider);
    expect(getBearerTokenProvider).toHaveBeenCalledTimes(1);
    expect(getBearerTokenProvider).toHaveBeenCalledWith(
      expect.anything(),
      "https://cognitiveservices.azure.com/.default",
    );
  });

  test("uses the Azure AI Foundry scope for v1 endpoints", () => {
    const provider = getAzureOpenAiBearerTokenProvider(
      "https://resource.services.ai.azure.com/openai/v1",
    );
    const sameProvider = getAzureAiFoundryBearerTokenProvider();

    expect(provider).toBe(sameProvider);
    expect(getBearerTokenProvider).toHaveBeenCalledWith(
      expect.anything(),
      "https://ai.azure.com/.default",
    );
  });
});
