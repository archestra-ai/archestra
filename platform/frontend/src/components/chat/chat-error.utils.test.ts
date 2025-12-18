import { ChatErrorCode } from "@shared";
import { describe, expect, it } from "vitest";
import {
  AI_SDK_INTERNAL_TYPES,
  deepParseJson,
  formatOriginalError,
  parseErrorResponse,
} from "./chat-error.utils";

describe("chat-error.utils", () => {
  describe("parseErrorResponse", () => {
    it("should parse valid ChatErrorResponse from error message", () => {
      const chatError = {
        code: ChatErrorCode.Authentication,
        message: "Invalid API key",
        isRetryable: false,
      };
      const error = new Error(JSON.stringify(chatError));

      const result = parseErrorResponse(error);

      expect(result).toEqual(chatError);
    });

    it("should return null for non-JSON error message", () => {
      const error = new Error("Some plain text error");

      const result = parseErrorResponse(error);

      expect(result).toBeNull();
    });

    it("should return null for JSON that is not a ChatErrorResponse", () => {
      const error = new Error(JSON.stringify({ foo: "bar" }));

      const result = parseErrorResponse(error);

      expect(result).toBeNull();
    });

    it("should return null for invalid JSON", () => {
      const error = new Error("{invalid json}");

      const result = parseErrorResponse(error);

      expect(result).toBeNull();
    });

    it("should parse ChatErrorResponse with originalError", () => {
      const chatError = {
        code: ChatErrorCode.ServerError,
        message: "Server error occurred",
        isRetryable: true,
        originalError: {
          provider: "gemini" as const,
          status: 500,
          message: "Internal error",
        },
      };
      const error = new Error(JSON.stringify(chatError));

      const result = parseErrorResponse(error);

      expect(result).toEqual(chatError);
    });
  });

  describe("deepParseJson", () => {
    it("should return non-string values unchanged", () => {
      expect(deepParseJson(123)).toBe(123);
      expect(deepParseJson(true)).toBe(true);
      expect(deepParseJson(null)).toBe(null);
      expect(deepParseJson(undefined)).toBe(undefined);
    });

    it("should return non-JSON strings unchanged", () => {
      expect(deepParseJson("hello world")).toBe("hello world");
      expect(deepParseJson("not json")).toBe("not json");
    });

    it("should parse simple JSON strings", () => {
      const result = deepParseJson('{"key": "value"}');

      expect(result).toEqual({ key: "value" });
    });

    it("should recursively parse nested JSON strings", () => {
      // JSON inside JSON
      const nestedJson = JSON.stringify({
        outer: JSON.stringify({ inner: "value" }),
      });

      const result = deepParseJson(nestedJson);

      expect(result).toEqual({
        outer: { inner: "value" },
      });
    });

    it("should handle deeply nested JSON (3+ levels)", () => {
      const level3 = JSON.stringify({ deepValue: "found" });
      const level2 = JSON.stringify({ level3: level3 });
      const level1 = JSON.stringify({ level2: level2 });

      const result = deepParseJson(level1);

      expect(result).toEqual({
        level2: {
          level3: {
            deepValue: "found",
          },
        },
      });
    });

    it("should handle arrays with nested JSON strings", () => {
      const item = JSON.stringify({ nested: true });
      const array = [item, "plain", 123];

      const result = deepParseJson(array);

      expect(result).toEqual([{ nested: true }, "plain", 123]);
    });

    it("should handle objects with nested JSON strings", () => {
      const nestedValue = JSON.stringify({ inner: "data" });
      const obj = {
        key1: nestedValue,
        key2: "plain string",
        key3: 42,
      };

      const result = deepParseJson(obj);

      expect(result).toEqual({
        key1: { inner: "data" },
        key2: "plain string",
        key3: 42,
      });
    });

    it("should handle real Gemini error structure", () => {
      // Simulating the deeply nested Gemini error structure
      const innerError = JSON.stringify({
        error: {
          code: 400,
          message: "API key not valid",
          status: "INVALID_ARGUMENT",
        },
      });
      const middleError = JSON.stringify({
        error: { message: innerError, code: 400, status: "Bad Request" },
      });
      const outerError = JSON.stringify({
        error: { message: middleError, type: "api_validation_error" },
      });

      const result = deepParseJson(outerError);

      expect(result).toEqual({
        error: {
          message: {
            error: {
              message: {
                error: {
                  code: 400,
                  message: "API key not valid",
                  status: "INVALID_ARGUMENT",
                },
              },
              code: 400,
              status: "Bad Request",
            },
          },
          type: "api_validation_error",
        },
      });
    });
  });

  describe("formatOriginalError", () => {
    it("should return default message for undefined", () => {
      const result = formatOriginalError(undefined);

      expect(result).toBe("No additional details available");
    });

    it("should format provider", () => {
      const result = formatOriginalError({
        provider: "gemini",
      });

      expect(result).toContain("Provider: gemini");
    });

    it("should format status", () => {
      const result = formatOriginalError({
        status: 400,
      });

      expect(result).toContain("Status: 400");
    });

    it("should format custom error type", () => {
      const result = formatOriginalError({
        type: "custom_error_type",
      });

      expect(result).toContain("Type: custom_error_type");
    });

    it("should skip AI SDK internal error types", () => {
      for (const internalType of AI_SDK_INTERNAL_TYPES) {
        const result = formatOriginalError({
          type: internalType,
        });

        expect(result).not.toContain(`Type: ${internalType}`);
      }
    });

    it("should format message", () => {
      const result = formatOriginalError({
        message: "Something went wrong",
      });

      expect(result).toContain("Message: Something went wrong");
    });

    it("should format raw error as pretty-printed JSON", () => {
      const result = formatOriginalError({
        raw: { error: { code: 400, message: "Bad request" } },
      });

      expect(result).toContain("Raw Error:");
      expect(result).toContain('"error"');
      expect(result).toContain('"code": 400');
      expect(result).toContain('"message": "Bad request"');
    });

    it("should deep parse nested JSON in raw error", () => {
      const nestedJson = JSON.stringify({ inner: "value" });
      const result = formatOriginalError({
        raw: { nested: nestedJson },
      });

      // The nested JSON string should be parsed and pretty-printed
      expect(result).toContain('"inner": "value"');
    });

    it("should format all fields together", () => {
      const result = formatOriginalError({
        provider: "anthropic",
        status: 401,
        type: "authentication_error",
        message: "Invalid API key",
        raw: { details: "additional info" },
      });

      expect(result).toContain("Provider: anthropic");
      expect(result).toContain("Status: 401");
      expect(result).toContain("Type: authentication_error");
      expect(result).toContain("Message: Invalid API key");
      expect(result).toContain("Raw Error:");
      expect(result).toContain('"details": "additional info"');
    });
  });

  describe("AI_SDK_INTERNAL_TYPES", () => {
    it("should contain expected AI SDK error type names", () => {
      expect(AI_SDK_INTERNAL_TYPES).toContain("AI_APICallError");
      expect(AI_SDK_INTERNAL_TYPES).toContain("AI_RetryError");
      expect(AI_SDK_INTERNAL_TYPES).toContain("APICallError");
      expect(AI_SDK_INTERNAL_TYPES).toContain("RetryError");
    });
  });
});
