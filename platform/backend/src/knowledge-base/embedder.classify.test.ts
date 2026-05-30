import { EmbeddingErrorCode } from "@shared";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, test } from "vitest";
import { classifyEmbeddingError } from "./embedder.classify";
import {
  AzureEmbeddingError,
  GeminiEmbeddingError,
  OpenAIEmbeddingError,
} from "./embedding-clients";

describe("classifyEmbeddingError", () => {
  describe("API errors — delegates to mapHttpStatusToEmbeddingError", () => {
    test("OpenAI 401 → Authentication", () => {
      expect(
        classifyEmbeddingError(new OpenAIEmbeddingError(401, "Unauthorized")),
      ).toBe(EmbeddingErrorCode.Authentication);
    });

    test("Azure 401 → Authentication", () => {
      expect(
        classifyEmbeddingError(new AzureEmbeddingError(401, "Unauthorized")),
      ).toBe(EmbeddingErrorCode.Authentication);
    });

    test("Gemini 401 → Authentication", () => {
      expect(
        classifyEmbeddingError(new GeminiEmbeddingError(401, "Unauthorized")),
      ).toBe(EmbeddingErrorCode.Authentication);
    });
  });

  describe("400 + context_length special case", () => {
    test("OpenAI 400 with context length message → ContextTooLong", () => {
      expect(
        classifyEmbeddingError(
          new OpenAIEmbeddingError(
            400,
            "the input length exceeds the context length",
          ),
        ),
      ).toBe(EmbeddingErrorCode.ContextTooLong);
    });

    test("Azure 400 with context length message → ContextTooLong", () => {
      expect(
        classifyEmbeddingError(
          new AzureEmbeddingError(
            400,
            "the input length exceeds the context length",
          ),
        ),
      ).toBe(EmbeddingErrorCode.ContextTooLong);
    });

    test("Gemini 400 with context length message → ContextTooLong", () => {
      expect(
        classifyEmbeddingError(
          new GeminiEmbeddingError(
            400,
            "the input length exceeds the context length",
          ),
        ),
      ).toBe(EmbeddingErrorCode.ContextTooLong);
    });
  });

  describe("LengthMismatch", () => {
    test("message matching the length mismatch pattern → LengthMismatch", () => {
      expect(
        classifyEmbeddingError(
          new Error("Embedding API returned 2 results for 3 inputs"),
        ),
      ).toBe(EmbeddingErrorCode.LengthMismatch);
    });

    test("message not matching the pattern → Unknown", () => {
      expect(
        classifyEmbeddingError(new Error("Embedding API returned bad data")),
      ).toBe(EmbeddingErrorCode.Unknown);
    });
  });

  describe("DimensionsMismatch", () => {
    test("DrizzleQueryError with 'dimensions' in message → DimensionsMismatch", () => {
      expect(
        classifyEmbeddingError(
          new DrizzleQueryError(
            "different vector dimensions 1536 and 3072",
            [],
          ),
        ),
      ).toBe(EmbeddingErrorCode.DimensionsMismatch);
    });

    test("DrizzleQueryError with 'dimensions' in cause chain → DimensionsMismatch", () => {
      const cause = new Error("different vector dimensions 1536 and 3072");
      const wrapper = new DrizzleQueryError("query failed", [], cause);
      expect(classifyEmbeddingError(wrapper)).toBe(
        EmbeddingErrorCode.DimensionsMismatch,
      );
    });

    test("DrizzleQueryError without dimensions message → Unknown", () => {
      expect(
        classifyEmbeddingError(
          new DrizzleQueryError("column does not exist", []),
        ),
      ).toBe(EmbeddingErrorCode.Unknown);
    });
  });

  describe("catch-all → Unknown", () => {
    test("null", () => {
      expect(classifyEmbeddingError(null)).toBe(EmbeddingErrorCode.Unknown);
    });

    test("plain string", () => {
      expect(classifyEmbeddingError("something went wrong")).toBe(
        EmbeddingErrorCode.Unknown,
      );
    });

    test("plain object", () => {
      expect(classifyEmbeddingError({ code: "ERR" })).toBe(
        EmbeddingErrorCode.Unknown,
      );
    });

    test("plain Error", () => {
      expect(classifyEmbeddingError(new Error("unexpected"))).toBe(
        EmbeddingErrorCode.Unknown,
      );
    });
  });
});
