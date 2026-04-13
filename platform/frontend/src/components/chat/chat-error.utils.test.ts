import { ChatErrorCode, ChatErrorMessages, RetryableErrorCodes } from "@shared";
import { describe, expect, it } from "vitest";
import { mapClientError, parseErrorResponse } from "./chat-error.utils";

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
