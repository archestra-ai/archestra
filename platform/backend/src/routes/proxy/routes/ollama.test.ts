import { describe, expect, test } from "@/test";
import { rewriteOllamaProxyUrl } from "./ollama";

const API_PREFIX = "/v1/ollama";

describe("rewriteOllamaProxyUrl", () => {
  const UUID = "da0e7287-c7dd-46a6-a0bf-69e6412d7a9c";

  describe("with UUID in path", () => {
    test("rewrites /models to /v1/models", () => {
      const result = rewriteOllamaProxyUrl(
        `${API_PREFIX}/${UUID}/models`,
        API_PREFIX,
      );
      expect(result).toEqual({
        rewrittenUrl: `${API_PREFIX}/v1/models`,
        proxyPath: "/v1/models",
        strippedUuid: true,
      });
    });

    test("rewrites /completions to /v1/completions", () => {
      const result = rewriteOllamaProxyUrl(
        `${API_PREFIX}/${UUID}/completions`,
        API_PREFIX,
      );
      expect(result).toEqual({
        rewrittenUrl: `${API_PREFIX}/v1/completions`,
        proxyPath: "/v1/completions",
        strippedUuid: true,
      });
    });

    test("preserves native /api/tags path without /v1 prefix", () => {
      const result = rewriteOllamaProxyUrl(
        `${API_PREFIX}/${UUID}/api/tags`,
        API_PREFIX,
      );
      expect(result).toEqual({
        rewrittenUrl: `${API_PREFIX}/api/tags`,
        proxyPath: "/api/tags",
        strippedUuid: true,
      });
    });

    test("preserves native /api/chat path without /v1 prefix", () => {
      const result = rewriteOllamaProxyUrl(
        `${API_PREFIX}/${UUID}/api/chat`,
        API_PREFIX,
      );
      expect(result).toEqual({
        rewrittenUrl: `${API_PREFIX}/api/chat`,
        proxyPath: "/api/chat",
        strippedUuid: true,
      });
    });

    test("preserves native /api/generate path without /v1 prefix", () => {
      const result = rewriteOllamaProxyUrl(
        `${API_PREFIX}/${UUID}/api/generate`,
        API_PREFIX,
      );
      expect(result).toEqual({
        rewrittenUrl: `${API_PREFIX}/api/generate`,
        proxyPath: "/api/generate",
        strippedUuid: true,
      });
    });

    test("handles UUID-only path (no trailing path)", () => {
      const result = rewriteOllamaProxyUrl(`${API_PREFIX}/${UUID}`, API_PREFIX);
      expect(result).toEqual({
        rewrittenUrl: `${API_PREFIX}/v1`,
        proxyPath: "/v1",
        strippedUuid: true,
      });
    });
  });

  describe("without UUID in path", () => {
    test("rewrites /models to /v1/models", () => {
      const result = rewriteOllamaProxyUrl(`${API_PREFIX}/models`, API_PREFIX);
      expect(result).toEqual({
        rewrittenUrl: `${API_PREFIX}/v1/models`,
        proxyPath: "/v1/models",
        strippedUuid: false,
      });
    });

    test("preserves native /api/tags path without /v1 prefix", () => {
      const result = rewriteOllamaProxyUrl(
        `${API_PREFIX}/api/tags`,
        API_PREFIX,
      );
      expect(result).toEqual({
        rewrittenUrl: `${API_PREFIX}/api/tags`,
        proxyPath: "/api/tags",
        strippedUuid: false,
      });
    });

    test("preserves native /api/pull path without /v1 prefix", () => {
      const result = rewriteOllamaProxyUrl(
        `${API_PREFIX}/api/pull`,
        API_PREFIX,
      );
      expect(result).toEqual({
        rewrittenUrl: `${API_PREFIX}/api/pull`,
        proxyPath: "/api/pull",
        strippedUuid: false,
      });
    });

    test("rewrites /embeddings to /v1/embeddings", () => {
      const result = rewriteOllamaProxyUrl(
        `${API_PREFIX}/embeddings`,
        API_PREFIX,
      );
      expect(result).toEqual({
        rewrittenUrl: `${API_PREFIX}/v1/embeddings`,
        proxyPath: "/v1/embeddings",
        strippedUuid: false,
      });
    });
  });

  describe("edge cases", () => {
    test("double /v1: path already prefixed with /v1 gets prefixed again", () => {
      const result = rewriteOllamaProxyUrl(
        `${API_PREFIX}/${UUID}/v1/models`,
        API_PREFIX,
      );
      // The function unconditionally prepends /v1 for non-/api/ paths.
      // In practice the proxy layer never sends /v1-prefixed paths, but
      // this documents the current behavior.
      expect(result).toEqual({
        rewrittenUrl: `${API_PREFIX}/v1/v1/models`,
        proxyPath: "/v1/v1/models",
        strippedUuid: true,
      });
    });

    test("preserves query strings on OpenAI-compat paths", () => {
      const result = rewriteOllamaProxyUrl(
        `${API_PREFIX}/${UUID}/models?page=1&limit=10`,
        API_PREFIX,
      );
      expect(result).toEqual({
        rewrittenUrl: `${API_PREFIX}/v1/models?page=1&limit=10`,
        proxyPath: "/v1/models?page=1&limit=10",
        strippedUuid: true,
      });
    });

    test("preserves query strings on native /api/ paths", () => {
      const result = rewriteOllamaProxyUrl(
        `${API_PREFIX}/${UUID}/api/tags?verbose=true`,
        API_PREFIX,
      );
      expect(result).toEqual({
        rewrittenUrl: `${API_PREFIX}/api/tags?verbose=true`,
        proxyPath: "/api/tags?verbose=true",
        strippedUuid: true,
      });
    });
  });
});
