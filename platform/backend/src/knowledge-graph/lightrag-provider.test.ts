import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { type LightRAGConfig, LightRAGProvider } from "./lightrag-provider";

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("LightRAGProvider", () => {
  let provider: LightRAGProvider;
  const config: LightRAGConfig = {
    apiUrl: "http://localhost:9621",
    apiKey: "test-api-key",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LightRAGProvider(config);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("constructor and properties", () => {
    test("has correct providerId", () => {
      expect(provider.providerId).toBe("lightrag");
    });

    test("has correct displayName", () => {
      expect(provider.displayName).toBe("LightRAG");
    });
  });

  describe("isConfigured", () => {
    test("returns true when apiUrl is set", () => {
      expect(provider.isConfigured()).toBe(true);
    });

    test("returns false when apiUrl is empty", () => {
      const unconfiguredProvider = new LightRAGProvider({
        apiUrl: "",
        apiKey: undefined,
      });
      expect(unconfiguredProvider.isConfigured()).toBe(false);
    });
  });

  describe("initialize", () => {
    test("throws error when not configured", async () => {
      const unconfiguredProvider = new LightRAGProvider({
        apiUrl: "",
        apiKey: undefined,
      });

      await expect(unconfiguredProvider.initialize()).rejects.toThrow(
        "LightRAG provider is not configured",
      );
    });

    test("throws error when health check fails", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: "unhealthy" }),
      });

      await expect(provider.initialize()).rejects.toThrow(
        "LightRAG health check failed",
      );
    });

    test("succeeds when health check passes", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: "healthy" }),
      });

      await expect(provider.initialize()).resolves.not.toThrow();
    });

    test("throws error on network failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      await expect(provider.initialize()).rejects.toThrow("Network error");
    });
  });

  describe("cleanup", () => {
    test("completes without error", async () => {
      await expect(provider.cleanup()).resolves.not.toThrow();
    });
  });

  describe("insertDocument", () => {
    test("sends correct request to LightRAG API", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "success",
            message: "Document inserted",
            document_count: 1,
          }),
      });

      await provider.insertDocument({
        content: "Test document content",
        filename: "test.txt",
        metadata: { author: "test" },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9621/documents/text",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": "test-api-key",
          },
          body: JSON.stringify({
            text: "Test document content",
            metadata: { filename: "test.txt", author: "test" },
          }),
        },
      );
    });

    test("returns pending status on success", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "success",
            message: "Document inserted",
            document_count: 1,
          }),
      });

      const result = await provider.insertDocument({
        content: "Test content",
        filename: "test.txt",
      });

      expect(result).toEqual({
        documentId: "test.txt",
        status: "pending",
        error: undefined,
      });
    });

    test("returns failed status on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal server error"),
      });

      const result = await provider.insertDocument({
        content: "Test content",
        filename: "test.txt",
      });

      expect(result).toEqual({
        documentId: "",
        status: "failed",
        error: "LightRAG API error: 500 - Internal server error",
      });
    });

    test("returns failed status on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

      const result = await provider.insertDocument({
        content: "Test content",
        filename: "test.txt",
      });

      expect(result).toEqual({
        documentId: "",
        status: "failed",
        error: "Connection refused",
      });
    });

    test("uses generated documentId when filename not provided", async () => {
      // Mock Date.now to have predictable ID
      const mockNow = 1704067200000;
      vi.spyOn(Date, "now").mockReturnValue(mockNow);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "success",
            message: "Document inserted",
          }),
      });

      const result = await provider.insertDocument({
        content: "Test content",
      });

      expect(result.documentId).toBe(`doc-${mockNow}`);

      vi.spyOn(Date, "now").mockRestore();
    });

    test("does not include X-API-Key header when apiKey is not set", async () => {
      const providerWithoutKey = new LightRAGProvider({
        apiUrl: "http://localhost:9621",
        apiKey: undefined,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "success",
            message: "Document inserted",
          }),
      });

      await providerWithoutKey.insertDocument({
        content: "Test content",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9621/documents/text",
        expect.objectContaining({
          headers: {
            "Content-Type": "application/json",
            // No X-API-Key header
          },
        }),
      );
    });
  });

  describe("queryDocument", () => {
    test("sends correct request to LightRAG API", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            response: "This is the answer",
          }),
      });

      await provider.queryDocument("What is the answer?");

      expect(mockFetch).toHaveBeenCalledWith("http://localhost:9621/query", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": "test-api-key",
        },
        body: JSON.stringify({
          query: "What is the answer?",
          mode: "hybrid",
        }),
      });
    });

    test("returns answer on success", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            response: "The CEO is Dr. Alexandra Chen",
          }),
      });

      const result = await provider.queryDocument("Who is the CEO?");

      expect(result).toEqual({
        answer: "The CEO is Dr. Alexandra Chen",
      });
    });

    test("returns error message on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Bad request"),
      });

      const result = await provider.queryDocument("Invalid query");

      expect(result).toEqual({
        answer: "Error querying knowledge graph: Bad request",
      });
    });

    test("returns error message on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Connection timeout"));

      const result = await provider.queryDocument("Any query");

      expect(result).toEqual({
        answer: "Error querying knowledge graph: Connection timeout",
      });
    });
  });

  describe("getHealth", () => {
    test("sends correct request to health endpoint", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: "healthy" }),
      });

      await provider.getHealth();

      expect(mockFetch).toHaveBeenCalledWith("http://localhost:9621/health", {
        method: "GET",
        headers: {
          "X-API-Key": "test-api-key",
        },
      });
    });

    test("returns healthy status when service is healthy", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "healthy",
            working_directory: "/data",
          }),
      });

      const result = await provider.getHealth();

      expect(result).toEqual({
        status: "healthy",
        message: undefined,
      });
    });

    test("returns unhealthy status when service returns unhealthy", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "degraded",
          }),
      });

      const result = await provider.getHealth();

      expect(result).toEqual({
        status: "unhealthy",
        message: "degraded",
      });
    });

    test("returns unhealthy status on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      });

      const result = await provider.getHealth();

      expect(result).toEqual({
        status: "unhealthy",
        message: "HTTP 503: Service Unavailable",
      });
    });

    test("returns unhealthy status on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("DNS resolution failed"));

      const result = await provider.getHealth();

      expect(result).toEqual({
        status: "unhealthy",
        message: "DNS resolution failed",
      });
    });

    test("does not include X-API-Key header when apiKey is not set", async () => {
      const providerWithoutKey = new LightRAGProvider({
        apiUrl: "http://localhost:9621",
        apiKey: undefined,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ status: "healthy" }),
      });

      await providerWithoutKey.getHealth();

      expect(mockFetch).toHaveBeenCalledWith("http://localhost:9621/health", {
        method: "GET",
        headers: {},
      });
    });
  });
});
