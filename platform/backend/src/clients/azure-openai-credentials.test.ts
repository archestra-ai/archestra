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
    },
  },
}));

import { getBearerTokenProvider } from "@azure/identity";
import {
  getAzureOpenAiBearerTokenProvider,
  isAzureOpenAiEntraIdEnabled,
} from "./azure-openai-credentials";

describe("azure-openai-credentials", () => {
  test("reports Entra ID auth as enabled from config", () => {
    expect(isAzureOpenAiEntraIdEnabled()).toBe(true);
  });

  test("creates a cached bearer token provider with the Azure OpenAI scope", () => {
    const provider = getAzureOpenAiBearerTokenProvider();
    const sameProvider = getAzureOpenAiBearerTokenProvider();

    expect(provider).toBe(sameProvider);
    expect(getBearerTokenProvider).toHaveBeenCalledTimes(1);
    expect(getBearerTokenProvider).toHaveBeenCalledWith(
      expect.anything(),
      "https://cognitiveservices.azure.com/.default",
    );
  });
});
