import { vi } from "vitest";
import { describe, expect, test } from "@/test";

function createMockProviderInstance() {
  return {
    providerId: "lightrag" as const,
    displayName: "LightRAG",
    isConfigured: vi.fn().mockReturnValue(true),
    initialize: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    insertDocument: vi.fn(),
    queryDocument: vi.fn(),
    getHealth: vi.fn(),
  };
}

const { mockLightRAGProvider } = vi.hoisted(() => {
  return {
    mockLightRAGProvider: vi.fn(),
  };
});

vi.mock("./lightrag-provider", () => ({
  LightRAGProvider: mockLightRAGProvider,
}));

import { createKnowledgeBaseProvider } from "./index";
import { LightRAGProvider } from "./lightrag-provider";

describe("createKnowledgeBaseProvider", () => {
  test("creates LightRAGProvider with valid config", () => {
    // biome-ignore lint/complexity/useArrowFunction: must use function expression for vi.fn constructor mock (new keyword)
    mockLightRAGProvider.mockImplementation(function () {
      return createMockProviderInstance();
    });

    const provider = createKnowledgeBaseProvider("lightrag", {
      apiUrl: "http://localhost:9621",
      apiKey: "test-key",
    });

    expect(LightRAGProvider).toHaveBeenCalledWith({
      apiUrl: "http://localhost:9621",
      apiKey: "test-key",
    });
    expect(provider).toBeDefined();
    expect(provider.providerId).toBe("lightrag");
  });

  test("throws error for unknown provider type", () => {
    expect(() =>
      createKnowledgeBaseProvider("unknown" as "lightrag", {
        apiUrl: "http://localhost:9621",
      }),
    ).toThrow("Unknown knowledge base provider type: unknown");
  });
});
