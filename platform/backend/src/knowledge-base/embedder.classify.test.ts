import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, test } from "vitest";
import { classifyEmbeddingError } from "./embedder";
import {
  AzureEmbeddingError,
  GeminiEmbeddingError,
  OpenAIEmbeddingError,
} from "./embedding-clients";

describe("classifyEmbeddingError", () => {
  describe("API errors — status-based", () => {
    test.each([
      [400, "invalid request parameter", "api_bad_request"],
      [400, "", "api_bad_request"],
      [401, "Incorrect API key", "api_unauthorized"],
      [403, "Forbidden", "api_permission_denied"],
      [404, "Model not found", "api_not_found"],
      [409, "Conflict", "api_conflict"],
      [422, "Unprocessable", "api_unprocessable_entity"],
      [429, "Rate limited", "api_rate_limit"],
      [500, "Server error", "api_generic_error"],
      [503, "Unavailable", "api_generic_error"],
    ] as const)("OpenAIEmbeddingError(%i) → %s", (status, message, expected) => {
      expect(
        classifyEmbeddingError(new OpenAIEmbeddingError(status, message)),
      ).toBe(expected);
    });

    test("AzureEmbeddingError(401) → api_unauthorized", () => {
      expect(
        classifyEmbeddingError(new AzureEmbeddingError(401, "Unauthorized")),
      ).toBe("api_unauthorized");
    });

    test("GeminiEmbeddingError(429) → api_rate_limit", () => {
      expect(
        classifyEmbeddingError(new GeminiEmbeddingError(429, "Rate limited")),
      ).toBe("api_rate_limit");
    });

    test("GeminiEmbeddingError(400) → api_bad_request", () => {
      expect(
        classifyEmbeddingError(new GeminiEmbeddingError(400, "bad request")),
      ).toBe("api_bad_request");
    });
  });

  describe("400 with context length message", () => {
    test("exact message → context_length_exceeded", () => {
      expect(
        classifyEmbeddingError(
          new OpenAIEmbeddingError(
            400,
            "the input length exceeds the context length",
          ),
        ),
      ).toBe("context_length_exceeded");
    });

    test("substring match → context_length_exceeded", () => {
      expect(
        classifyEmbeddingError(
          new OpenAIEmbeddingError(
            400,
            "something something the input length exceeds the context length for this model",
          ),
        ),
      ).toBe("context_length_exceeded");
    });

    test("Azure 400 with context length message → context_length_exceeded", () => {
      expect(
        classifyEmbeddingError(
          new AzureEmbeddingError(
            400,
            "the input length exceeds the context length",
          ),
        ),
      ).toBe("context_length_exceeded");
    });
  });

  describe("length mismatch", () => {
    test("exact format → length_mismatch", () => {
      expect(
        classifyEmbeddingError(
          new Error("Embedding API returned 2 results for 3 inputs"),
        ),
      ).toBe("length_mismatch");
    });

    test("extra trailing text (anchored regex) → unknown", () => {
      expect(
        classifyEmbeddingError(
          new Error(
            "Embedding API returned 2 results for 3 inputs with extra text",
          ),
        ),
      ).toBe("unknown");
    });

    test("lowercase → unknown (case-sensitive)", () => {
      expect(
        classifyEmbeddingError(
          new Error("embedding api returned 2 results for 3 inputs"),
        ),
      ).toBe("unknown");
    });
  });

  describe("dimensions mismatch (DrizzleQueryError + cause chain)", () => {
    test("direct cause with dimensions message → dimensions_mismatch", () => {
      const cause = new Error("expected 1536 dimensions, not 3072");
      const drizzleErr = new DrizzleQueryError("UPDATE ...", [], cause);
      expect(classifyEmbeddingError(drizzleErr)).toBe("dimensions_mismatch");
    });

    test("cause without dimensions keyword → unknown", () => {
      const cause = new Error("no dimension problem here");
      const drizzleErr = new DrizzleQueryError("UPDATE ...", [], cause);
      expect(classifyEmbeddingError(drizzleErr)).toBe("unknown");
    });

    test("plain Error (not DrizzleQueryError) with dimensions message → unknown", () => {
      expect(
        classifyEmbeddingError(new Error("expected 1536 dimensions, not 3072")),
      ).toBe("unknown");
    });

    test("dimensions at depth 2 → dimensions_mismatch", () => {
      const inner = new Error("expected 1536 dimensions, not 3072");
      const mid = new Error("wrapper", { cause: inner });
      const drizzleErr = new DrizzleQueryError("UPDATE ...", [], mid);
      expect(classifyEmbeddingError(drizzleErr)).toBe("dimensions_mismatch");
    });

    test("dimensions at depth 5 (boundary) → dimensions_mismatch", () => {
      let err: Error = new Error("expected 1536 dimensions, not 3072");
      for (let i = 0; i < 4; i++) {
        err = new Error("wrapper", { cause: err });
      }
      const drizzleErr = new DrizzleQueryError("UPDATE ...", [], err);
      expect(classifyEmbeddingError(drizzleErr)).toBe("dimensions_mismatch");
    });

    test("dimensions at depth 6 (past cap) → unknown", () => {
      let err: Error = new Error("expected 1536 dimensions, not 3072");
      for (let i = 0; i < 5; i++) {
        err = new Error("wrapper", { cause: err });
      }
      const drizzleErr = new DrizzleQueryError("UPDATE ...", [], err);
      expect(classifyEmbeddingError(drizzleErr)).toBe("unknown");
    });
  });

  describe("catch-all", () => {
    test("plain unknown error → unknown", () => {
      expect(classifyEmbeddingError(new Error("some unknown error"))).toBe(
        "unknown",
      );
    });

    test("thrown string → unknown", () => {
      expect(classifyEmbeddingError("oops")).toBe("unknown");
    });

    test("thrown null → unknown", () => {
      expect(classifyEmbeddingError(null)).toBe("unknown");
    });

    test("thrown plain object → unknown", () => {
      expect(classifyEmbeddingError({ message: "oops" })).toBe("unknown");
    });
  });
});
