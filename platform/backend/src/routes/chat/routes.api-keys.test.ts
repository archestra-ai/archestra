import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";
import { ApiError } from "@/types";

// Mock the Vertex AI check
vi.mock("@/clients/gemini-client", () => ({
  isVertexAiEnabled: vi.fn(),
}));

import { isVertexAiEnabled } from "@/clients/gemini-client";
import { validateProviderAllowed } from "./routes.api-keys";

const mockIsVertexAiEnabled = vi.mocked(isVertexAiEnabled);

describe("validateProviderAllowed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("throws error when creating Gemini API key with Vertex AI enabled", () => {
    mockIsVertexAiEnabled.mockReturnValue(true);

    expect(() => validateProviderAllowed("gemini")).toThrow(ApiError);
    expect(() => validateProviderAllowed("gemini")).toThrow(
      "Cannot create Gemini API key: Vertex AI is configured",
    );
  });

  test("allows Gemini API key creation when Vertex AI is disabled", () => {
    mockIsVertexAiEnabled.mockReturnValue(false);

    expect(() => validateProviderAllowed("gemini")).not.toThrow();
  });

  test("allows OpenAI API key creation regardless of Vertex AI status", () => {
    mockIsVertexAiEnabled.mockReturnValue(true);

    expect(() => validateProviderAllowed("openai")).not.toThrow();
  });

  test("allows Anthropic API key creation regardless of Vertex AI status", () => {
    mockIsVertexAiEnabled.mockReturnValue(true);

    expect(() => validateProviderAllowed("anthropic")).not.toThrow();
  });
});
