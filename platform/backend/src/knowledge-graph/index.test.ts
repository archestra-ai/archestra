import { vi } from "vitest";
import type * as originalConfigModule from "@/config";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

// Store mock config for modification in tests
const mockKnowledgeGraphConfig = {
  provider: undefined as "lightrag" | undefined,
  lightrag: {
    apiUrl: "",
    apiKey: undefined as string | undefined,
  },
};

// Mock the config module - use importOriginal to preserve database config
vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof originalConfigModule>();
  return {
    default: {
      ...actual.default,
      get knowledgeGraph() {
        return mockKnowledgeGraphConfig;
      },
    },
  };
});

// Create mock provider using vi.hoisted to ensure it's available before mock hoisting
const { mockLightRAGProvider } = vi.hoisted(() => {
  return {
    mockLightRAGProvider: vi.fn(),
  };
});

// Mock the LightRAG provider
vi.mock("./lightrag-provider", () => ({
  LightRAGProvider: mockLightRAGProvider,
}));

// Helper to create default mock provider instance
function createMockProviderInstance() {
  return {
    providerId: "lightrag" as const,
    displayName: "LightRAG",
    isConfigured: vi.fn().mockReturnValue(true),
    initialize: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
    insertDocument: vi.fn().mockResolvedValue({
      documentId: "doc-123",
      status: "pending",
    }),
    queryDocument: vi.fn().mockResolvedValue({
      answer: "Test answer",
    }),
    getHealth: vi.fn().mockResolvedValue({
      status: "healthy",
    }),
  };
}

// Helper to reset mock to default implementation
function resetMockProvider() {
  mockLightRAGProvider.mockReset();
  mockLightRAGProvider.mockImplementation(createMockProviderInstance);
}

import {
  cleanupKnowledgeGraphProvider,
  createKnowledgeGraphProvider,
  getKnowledgeGraphConfig,
  getKnowledgeGraphProvider,
  getKnowledgeGraphProviderAsync,
  getKnowledgeGraphProviderInfo,
  getKnowledgeGraphProviderType,
  ingestDocument,
  initializeKnowledgeGraphProvider,
  isKnowledgeGraphEnabled,
} from "./index";
import { LightRAGProvider } from "./lightrag-provider";

describe("getKnowledgeGraphConfig", () => {
  beforeEach(() => {
    mockKnowledgeGraphConfig.provider = undefined;
    mockKnowledgeGraphConfig.lightrag = { apiUrl: "", apiKey: undefined };
  });

  test("returns the knowledge graph config from config", () => {
    const result = getKnowledgeGraphConfig();
    expect(result).toBeDefined();
    expect(result).toHaveProperty("provider");
  });
});

describe("isKnowledgeGraphEnabled", () => {
  beforeEach(async () => {
    await cleanupKnowledgeGraphProvider();
    mockKnowledgeGraphConfig.provider = undefined;
    mockKnowledgeGraphConfig.lightrag = { apiUrl: "", apiKey: undefined };
  });

  test("returns false when provider is undefined", () => {
    expect(isKnowledgeGraphEnabled()).toBe(false);
  });

  test("returns true when provider is configured", () => {
    mockKnowledgeGraphConfig.provider = "lightrag";
    mockKnowledgeGraphConfig.lightrag = {
      apiUrl: "http://localhost:9621",
      apiKey: undefined,
    };
    expect(isKnowledgeGraphEnabled()).toBe(true);
  });
});

describe("getKnowledgeGraphProviderType", () => {
  beforeEach(async () => {
    await cleanupKnowledgeGraphProvider();
    mockKnowledgeGraphConfig.provider = undefined;
    mockKnowledgeGraphConfig.lightrag = { apiUrl: "", apiKey: undefined };
  });

  test("returns undefined when no provider is configured", () => {
    expect(getKnowledgeGraphProviderType()).toBeUndefined();
  });

  test("returns provider type when configured", () => {
    mockKnowledgeGraphConfig.provider = "lightrag";
    mockKnowledgeGraphConfig.lightrag = {
      apiUrl: "http://localhost:9621",
      apiKey: undefined,
    };
    expect(getKnowledgeGraphProviderType()).toBe("lightrag");
  });
});

describe("createKnowledgeGraphProvider", () => {
  beforeEach(() => {
    resetMockProvider();
  });

  test("creates LightRAGProvider with valid config", () => {
    const provider = createKnowledgeGraphProvider("lightrag", {
      provider: "lightrag",
      lightrag: {
        apiUrl: "http://localhost:9621",
        apiKey: "test-key",
      },
    });

    expect(LightRAGProvider).toHaveBeenCalledWith({
      apiUrl: "http://localhost:9621",
      apiKey: "test-key",
    });
    expect(provider).toBeDefined();
    expect(provider.providerId).toBe("lightrag");
  });

  test("throws error when lightrag config is missing", () => {
    expect(() =>
      createKnowledgeGraphProvider("lightrag", {
        provider: "lightrag",
        lightrag: undefined,
      }),
    ).toThrow("LightRAG provider configuration is missing");
  });

  test("throws error for unknown provider type", () => {
    expect(() =>
      createKnowledgeGraphProvider("unknown" as "lightrag", {
        provider: "unknown" as "lightrag",
      }),
    ).toThrow("Unknown knowledge graph provider type: unknown");
  });
});

describe("getKnowledgeGraphProvider", () => {
  beforeEach(async () => {
    resetMockProvider();
    // Reset singleton state by calling cleanup
    await cleanupKnowledgeGraphProvider();
    mockKnowledgeGraphConfig.provider = undefined;
    mockKnowledgeGraphConfig.lightrag = { apiUrl: "", apiKey: undefined };
  });

  afterEach(async () => {
    await cleanupKnowledgeGraphProvider();
  });

  test("returns null when no provider is configured", () => {
    const provider = getKnowledgeGraphProvider();
    expect(provider).toBeNull();
  });

  test("returns provider when configured", () => {
    mockKnowledgeGraphConfig.provider = "lightrag";
    mockKnowledgeGraphConfig.lightrag = {
      apiUrl: "http://localhost:9621",
      apiKey: undefined,
    };

    const provider = getKnowledgeGraphProvider();
    expect(provider).not.toBeNull();
    expect(provider?.providerId).toBe("lightrag");
  });

  test("returns same instance on subsequent calls (singleton)", () => {
    mockKnowledgeGraphConfig.provider = "lightrag";
    mockKnowledgeGraphConfig.lightrag = {
      apiUrl: "http://localhost:9621",
      apiKey: undefined,
    };

    const provider1 = getKnowledgeGraphProvider();
    const provider2 = getKnowledgeGraphProvider();
    expect(provider1).toBe(provider2);
  });

  test("returns null when provider is not configured properly", () => {
    // Mock provider that returns false for isConfigured
    vi.mocked(LightRAGProvider).mockImplementationOnce(
      () =>
        ({
          providerId: "lightrag",
          displayName: "LightRAG",
          isConfigured: vi.fn().mockReturnValue(false),
          initialize: vi.fn(),
          cleanup: vi.fn(),
          insertDocument: vi.fn(),
          queryDocument: vi.fn(),
          getHealth: vi.fn(),
        }) as unknown as InstanceType<typeof LightRAGProvider>,
    );

    mockKnowledgeGraphConfig.provider = "lightrag";
    mockKnowledgeGraphConfig.lightrag = {
      apiUrl: "http://localhost:9621",
      apiKey: undefined,
    };

    const provider = getKnowledgeGraphProvider();
    expect(provider).toBeNull();
  });
});

describe("getKnowledgeGraphProviderAsync", () => {
  beforeEach(async () => {
    resetMockProvider();
    await cleanupKnowledgeGraphProvider();
    mockKnowledgeGraphConfig.provider = undefined;
    mockKnowledgeGraphConfig.lightrag = { apiUrl: "", apiKey: undefined };
  });

  afterEach(async () => {
    await cleanupKnowledgeGraphProvider();
  });

  test("returns null when no provider is configured", async () => {
    const provider = await getKnowledgeGraphProviderAsync();
    expect(provider).toBeNull();
  });

  test("returns provider when configured", async () => {
    mockKnowledgeGraphConfig.provider = "lightrag";
    mockKnowledgeGraphConfig.lightrag = {
      apiUrl: "http://localhost:9621",
      apiKey: undefined,
    };

    const provider = await getKnowledgeGraphProviderAsync();
    expect(provider).not.toBeNull();
    expect(provider?.providerId).toBe("lightrag");
  });

  test("handles concurrent calls safely (returns same instance)", async () => {
    mockKnowledgeGraphConfig.provider = "lightrag";
    mockKnowledgeGraphConfig.lightrag = {
      apiUrl: "http://localhost:9621",
      apiKey: undefined,
    };

    // Make multiple concurrent calls
    const [provider1, provider2, provider3] = await Promise.all([
      getKnowledgeGraphProviderAsync(),
      getKnowledgeGraphProviderAsync(),
      getKnowledgeGraphProviderAsync(),
    ]);

    // All should return the same instance
    expect(provider1).toBe(provider2);
    expect(provider2).toBe(provider3);
    expect(provider1).not.toBeNull();
  });
});

describe("initializeKnowledgeGraphProvider", () => {
  beforeEach(async () => {
    resetMockProvider();
    await cleanupKnowledgeGraphProvider();
    mockKnowledgeGraphConfig.provider = undefined;
    mockKnowledgeGraphConfig.lightrag = { apiUrl: "", apiKey: undefined };
  });

  afterEach(async () => {
    await cleanupKnowledgeGraphProvider();
  });

  test("does nothing when no provider is configured", async () => {
    await expect(initializeKnowledgeGraphProvider()).resolves.not.toThrow();
  });

  test("initializes provider when configured", async () => {
    mockKnowledgeGraphConfig.provider = "lightrag";
    mockKnowledgeGraphConfig.lightrag = {
      apiUrl: "http://localhost:9621",
      apiKey: undefined,
    };

    await initializeKnowledgeGraphProvider();

    const provider = getKnowledgeGraphProvider();
    expect(provider).not.toBeNull();
    expect(provider?.initialize).toHaveBeenCalled();
  });

  test("handles initialization errors gracefully", async () => {
    vi.mocked(LightRAGProvider).mockImplementationOnce(
      () =>
        ({
          providerId: "lightrag",
          displayName: "LightRAG",
          isConfigured: vi.fn().mockReturnValue(true),
          initialize: vi.fn().mockRejectedValue(new Error("Init failed")),
          cleanup: vi.fn(),
          insertDocument: vi.fn(),
          queryDocument: vi.fn(),
          getHealth: vi.fn(),
        }) as unknown as InstanceType<typeof LightRAGProvider>,
    );

    mockKnowledgeGraphConfig.provider = "lightrag";
    mockKnowledgeGraphConfig.lightrag = {
      apiUrl: "http://localhost:9621",
      apiKey: undefined,
    };

    // Should not throw
    await expect(initializeKnowledgeGraphProvider()).resolves.not.toThrow();
  });
});

describe("cleanupKnowledgeGraphProvider", () => {
  beforeEach(async () => {
    resetMockProvider();
    await cleanupKnowledgeGraphProvider();
    mockKnowledgeGraphConfig.provider = undefined;
    mockKnowledgeGraphConfig.lightrag = { apiUrl: "", apiKey: undefined };
  });

  test("does nothing when no provider is initialized", async () => {
    await expect(cleanupKnowledgeGraphProvider()).resolves.not.toThrow();
  });

  test("cleans up initialized provider", async () => {
    mockKnowledgeGraphConfig.provider = "lightrag";
    mockKnowledgeGraphConfig.lightrag = {
      apiUrl: "http://localhost:9621",
      apiKey: undefined,
    };

    const provider = getKnowledgeGraphProvider();
    expect(provider).not.toBeNull();

    await cleanupKnowledgeGraphProvider();

    // After cleanup, reset config and verify new provider returns null
    mockKnowledgeGraphConfig.provider = undefined;
    mockKnowledgeGraphConfig.lightrag = { apiUrl: "", apiKey: undefined };

    const newProvider = getKnowledgeGraphProvider();
    expect(newProvider).toBeNull();
  });
});

describe("ingestDocument", () => {
  beforeEach(async () => {
    resetMockProvider();
    await cleanupKnowledgeGraphProvider();
    mockKnowledgeGraphConfig.provider = undefined;
    mockKnowledgeGraphConfig.lightrag = { apiUrl: "", apiKey: undefined };
  });

  afterEach(async () => {
    await cleanupKnowledgeGraphProvider();
  });

  test("returns false when no provider is configured", async () => {
    const result = await ingestDocument({
      content: "Test content",
      filename: "test.txt",
    });
    expect(result).toBe(false);
  });

  test("returns true on successful ingestion", async () => {
    mockKnowledgeGraphConfig.provider = "lightrag";
    mockKnowledgeGraphConfig.lightrag = {
      apiUrl: "http://localhost:9621",
      apiKey: undefined,
    };

    const result = await ingestDocument({
      content: "Test content",
      filename: "test.txt",
    });
    expect(result).toBe(true);
  });

  test("returns false when ingestion fails", async () => {
    vi.mocked(LightRAGProvider).mockImplementationOnce(
      () =>
        ({
          providerId: "lightrag",
          displayName: "LightRAG",
          isConfigured: vi.fn().mockReturnValue(true),
          initialize: vi.fn().mockResolvedValue(undefined),
          cleanup: vi.fn(),
          insertDocument: vi.fn().mockResolvedValue({
            documentId: "",
            status: "failed",
            error: "Ingestion failed",
          }),
          queryDocument: vi.fn(),
          getHealth: vi.fn(),
        }) as unknown as InstanceType<typeof LightRAGProvider>,
    );

    mockKnowledgeGraphConfig.provider = "lightrag";
    mockKnowledgeGraphConfig.lightrag = {
      apiUrl: "http://localhost:9621",
      apiKey: undefined,
    };

    const result = await ingestDocument({
      content: "Test content",
      filename: "test.txt",
    });
    expect(result).toBe(false);
  });

  test("handles errors during ingestion gracefully", async () => {
    vi.mocked(LightRAGProvider).mockImplementationOnce(
      () =>
        ({
          providerId: "lightrag",
          displayName: "LightRAG",
          isConfigured: vi.fn().mockReturnValue(true),
          initialize: vi.fn().mockResolvedValue(undefined),
          cleanup: vi.fn(),
          insertDocument: vi.fn().mockRejectedValue(new Error("Network error")),
          queryDocument: vi.fn(),
          getHealth: vi.fn(),
        }) as unknown as InstanceType<typeof LightRAGProvider>,
    );

    mockKnowledgeGraphConfig.provider = "lightrag";
    mockKnowledgeGraphConfig.lightrag = {
      apiUrl: "http://localhost:9621",
      apiKey: undefined,
    };

    const result = await ingestDocument({
      content: "Test content",
      filename: "test.txt",
    });
    expect(result).toBe(false);
  });
});

describe("getKnowledgeGraphProviderInfo", () => {
  beforeEach(async () => {
    resetMockProvider();
    await cleanupKnowledgeGraphProvider();
    mockKnowledgeGraphConfig.provider = undefined;
    mockKnowledgeGraphConfig.lightrag = { apiUrl: "", apiKey: undefined };
  });

  afterEach(async () => {
    await cleanupKnowledgeGraphProvider();
  });

  test("returns disabled info when no provider is configured", () => {
    const info = getKnowledgeGraphProviderInfo();
    expect(info).toEqual({
      enabled: false,
      provider: undefined,
      displayName: undefined,
    });
  });

  test("returns enabled info when provider is configured", () => {
    mockKnowledgeGraphConfig.provider = "lightrag";
    mockKnowledgeGraphConfig.lightrag = {
      apiUrl: "http://localhost:9621",
      apiKey: undefined,
    };

    const info = getKnowledgeGraphProviderInfo();
    expect(info).toEqual({
      enabled: true,
      provider: "lightrag",
      displayName: "LightRAG",
    });
  });
});
