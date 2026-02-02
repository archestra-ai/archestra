import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, test } from "@/test";

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
      // Use a non-retryable error message to avoid retry behavior in this test
      mockFetch.mockRejectedValueOnce(new Error("Invalid configuration"));

      await expect(provider.initialize()).rejects.toThrow(
        "Invalid configuration",
      );
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
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": "test-api-key",
          },
          body: JSON.stringify({
            text: "Test document content",
            metadata: { author: "test", filename: "test.txt" },
          }),
        }),
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
      // Use a non-retryable status code (4xx) to avoid retry behavior in this test
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Bad request"),
      });

      const result = await provider.insertDocument({
        content: "Test content",
        filename: "test.txt",
      });

      expect(result).toEqual({
        documentId: "",
        status: "failed",
        error: "LightRAG API error: 400 - Bad request",
      });
    });

    test("returns failed status on network error", async () => {
      // Use a non-retryable error message to avoid retry behavior in this test
      mockFetch.mockRejectedValueOnce(new Error("Request body too large"));

      const result = await provider.insertDocument({
        content: "Test content",
        filename: "test.txt",
      });

      expect(result).toEqual({
        documentId: "",
        status: "failed",
        error: "Request body too large",
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

    test("preserves metadata when filename is not provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "success",
            message: "Document inserted",
          }),
      });

      await provider.insertDocument({
        content: "Test content",
        metadata: { author: "test-author", source: "test-source" },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9621/documents/text",
        expect.objectContaining({
          body: JSON.stringify({
            text: "Test content",
            metadata: { author: "test-author", source: "test-source" },
          }),
        }),
      );
    });

    test("does not include metadata field when no metadata or filename provided", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            status: "success",
            message: "Document inserted",
          }),
      });

      await provider.insertDocument({
        content: "Test content",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9621/documents/text",
        expect.objectContaining({
          body: JSON.stringify({
            text: "Test content",
          }),
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

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9621/query",
        expect.objectContaining({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": "test-api-key",
          },
          body: JSON.stringify({
            query: "What is the answer?",
            mode: "hybrid",
          }),
        }),
      );
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

    test("returns structured error on API error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Bad request"),
      });

      const result = await provider.queryDocument("Invalid query");

      expect(result).toEqual({
        answer: "",
        error: "LightRAG API error: 400 - Bad request",
      });
    });

    test("returns structured error on network error", async () => {
      // Use a non-retryable error message to avoid retry behavior in this test
      mockFetch.mockRejectedValueOnce(new Error("Invalid request body"));

      const result = await provider.queryDocument("Any query");

      expect(result).toEqual({
        answer: "",
        error: "Invalid request body",
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

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9621/health",
        expect.objectContaining({
          method: "GET",
          headers: {
            "X-API-Key": "test-api-key",
          },
        }),
      );
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
      // Use a non-retryable status code (4xx) to avoid retry behavior in this test
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
      });

      const result = await provider.getHealth();

      expect(result).toEqual({
        status: "unhealthy",
        message: "HTTP 404: Not Found",
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

      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:9621/health",
        expect.objectContaining({
          method: "GET",
          headers: {},
        }),
      );
    });
  });

  describe("retry logic", () => {
    test("retries on 5xx server errors", async () => {
      // First two calls return 503, third succeeds
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          statusText: "Service Unavailable",
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ status: "healthy" }),
        });

      const result = await provider.getHealth();

      expect(result.status).toBe("healthy");
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    test("retries on 429 rate limiting", async () => {
      // First call returns 429, second succeeds
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              status: "success",
              message: "Document inserted",
            }),
        });

      const result = await provider.insertDocument({
        content: "Test content",
        filename: "test.txt",
      });

      expect(result.status).toBe("pending");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test("retries on transient network errors", async () => {
      // First call throws network error, second succeeds
      mockFetch
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ response: "Test answer" }),
        });

      const result = await provider.queryDocument("Test query");

      expect(result.answer).toBe("Test answer");
      expect(result.error).toBeUndefined();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    test("does not retry on 4xx client errors", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve("Bad request"),
      });

      const result = await provider.queryDocument("Invalid query");

      expect(result.error).toContain("400");
      // Should only be called once (no retry for 4xx)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test("gives up after max retries", async () => {
      // All calls fail with 503
      mockFetch.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: () => Promise.resolve("Service unavailable"),
      });

      const result = await provider.insertDocument({
        content: "Test content",
        filename: "test.txt",
      });

      expect(result.status).toBe("failed");
      // Initial + 3 retries = 4 calls
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    test("does not retry non-transient errors", async () => {
      // Non-transient error (e.g., invalid URL)
      mockFetch.mockRejectedValueOnce(new Error("Invalid URL format"));

      const result = await provider.insertDocument({
        content: "Test content",
        filename: "test.txt",
      });

      expect(result.status).toBe("failed");
      expect(result.error).toBe("Invalid URL format");
      // Should only be called once (no retry for non-transient errors)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });
});
