import { ChatErrorCode, ChatErrorMessages, RetryableErrorCodes } from "@shared";
import { describe, expect, it } from "vitest";
import {
  AI_SDK_INTERNAL_TYPES,
  deepParseJson,
  formatOriginalError,
  mapClientError,
  parseErrorResponse,
} from "./chat-error.utils";

describe("chat-error.utils", () => {
  describe("parseErrorResponse", () => {
    it("parses a valid structured chat error", () => {
      const chatError = {
        code: ChatErrorCode.Authentication,
        message: "Invalid API key",
        isRetryable: false,
      };

      expect(parseErrorResponse(new Error(JSON.stringify(chatError)))).toEqual(
        chatError,
      );
    });

    it("preserves correlation IDs from the structured payload", () => {
      const chatError = {
        code: ChatErrorCode.ServerError,
        message: "Server error occurred",
        isRetryable: true,
        sessionId: "session-123",
        traceId: "trace-123",
        spanId: "span-123",
      };

      expect(parseErrorResponse(new Error(JSON.stringify(chatError)))).toEqual(
        chatError,
      );
    });

    it("returns null for non-chat-error JSON", () => {
      expect(
        parseErrorResponse(new Error(JSON.stringify({ foo: "bar" }))),
      ).toBe(null);
    });

    it("returns null for invalid JSON", () => {
      expect(parseErrorResponse(new Error("{invalid json}"))).toBe(null);
    });

    it("parses originalError in the structured payload", () => {
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

      expect(parseErrorResponse(new Error(JSON.stringify(chatError)))).toEqual(
        chatError,
      );
    });
  });

  describe("deepParseJson", () => {
    it("returns non-string values unchanged", () => {
      expect(deepParseJson(123)).toBe(123);
      expect(deepParseJson(true)).toBe(true);
      expect(deepParseJson(null)).toBe(null);
      expect(deepParseJson(undefined)).toBe(undefined);
    });

    it("returns non-JSON strings unchanged", () => {
      expect(deepParseJson("hello world")).toBe("hello world");
      expect(deepParseJson("not json")).toBe("not json");
    });

    it("recursively parses nested JSON strings", () => {
      const nestedJson = JSON.stringify({
        outer: JSON.stringify({ inner: "value" }),
      });

      expect(deepParseJson(nestedJson)).toEqual({
        outer: { inner: "value" },
      });
    });

    it("handles deeply nested JSON beyond two levels", () => {
      const level3 = JSON.stringify({ deepValue: "found" });
      const level2 = JSON.stringify({ level3 });
      const level1 = JSON.stringify({ level2 });

      expect(deepParseJson(level1)).toEqual({
        level2: {
          level3: {
            deepValue: "found",
          },
        },
      });
    });

    it("handles arrays and objects with nested JSON strings", () => {
      const nestedValue = JSON.stringify({ inner: "data" });

      expect(deepParseJson([nestedValue, "plain", 123])).toEqual([
        { inner: "data" },
        "plain",
        123,
      ]);
      expect(
        deepParseJson({
          key1: nestedValue,
          key2: "plain string",
          key3: 42,
        }),
      ).toEqual({
        key1: { inner: "data" },
        key2: "plain string",
        key3: 42,
      });
    });

    it("handles the nested Gemini error structure", () => {
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

      expect(deepParseJson(outerError)).toEqual({
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
    it("returns the default message for undefined", () => {
      expect(formatOriginalError(undefined)).toBe(
        "No additional details available",
      );
    });

    it("formats provider, status, message, and raw error", () => {
      const result = formatOriginalError({
        provider: "anthropic",
        status: 401,
        message: "Invalid API key",
        raw: { details: "additional info" },
      });

      expect(result).toContain("Provider: anthropic");
      expect(result).toContain("Status: 401");
      expect(result).toContain("Message: Invalid API key");
      expect(result).toContain("Raw Error:");
      expect(result).toContain('"details": "additional info"');
    });

    it("skips AI SDK internal error types", () => {
      for (const internalType of AI_SDK_INTERNAL_TYPES) {
        const result = formatOriginalError({
          type: internalType,
        });

        expect(result).not.toContain(`Type: ${internalType}`);
      }
    });

    it("formats custom error types and deep parses raw JSON", () => {
      const result = formatOriginalError({
        type: "authentication_error",
        raw: { nested: JSON.stringify({ inner: "value" }) },
      });

      expect(result).toContain("Type: authentication_error");
      expect(result).toContain('"inner": "value"');
    });
  });

  describe("mapClientError", () => {
    it("maps retryable network failures", () => {
      expect(mapClientError(new Error("Failed to fetch"))).toEqual({
        code: ChatErrorCode.NetworkError,
        message: ChatErrorMessages[ChatErrorCode.NetworkError],
        isRetryable: true,
      });
    });

    it("extracts backend error.message from JSON envelopes", () => {
      expect(
        mapClientError(
          new Error(JSON.stringify({ error: { message: "Request failed" } })),
        ),
      ).toEqual({
        code: ChatErrorCode.Unknown,
        message: "Request failed",
        isRetryable: RetryableErrorCodes.has(ChatErrorCode.Unknown),
      });
    });
  });
});
