import { ChatErrorCode } from "@archestra/shared";
import { describe, expect, it } from "vitest";
import { isRetryableError, parseStructuredChatError } from "./chat-retry.utils";

function structuredError(code: ChatErrorCode, isRetryable: boolean): Error {
  return new Error(JSON.stringify({ code, message: "boom", isRetryable }));
}

describe("isRetryableError", () => {
  it("auto-retries a structured network_error", () => {
    expect(
      isRetryableError(structuredError(ChatErrorCode.NetworkError, true)),
    ).toBe(true);
  });

  it("does not auto-retry a network_error flagged non-retryable", () => {
    expect(
      isRetryableError(structuredError(ChatErrorCode.NetworkError, false)),
    ).toBe(false);
  });

  it("does not auto-retry other structured retryable codes (e.g. rate_limit)", () => {
    expect(
      isRetryableError(structuredError(ChatErrorCode.RateLimit, true)),
    ).toBe(false);
  });

  it("auto-retries unstructured client network failures", () => {
    expect(isRetryableError(new Error("Failed to fetch"))).toBe(true);
  });

  it("does not auto-retry an arbitrary unstructured error", () => {
    expect(isRetryableError(new Error("something unexpected"))).toBe(false);
  });
});

describe("parseStructuredChatError", () => {
  it("parses a structured chat error payload", () => {
    const parsed = parseStructuredChatError(
      JSON.stringify({
        code: ChatErrorCode.NetworkError,
        message: "boom",
        isRetryable: true,
      }),
    );
    expect(parsed?.code).toBe(ChatErrorCode.NetworkError);
  });

  it("returns null for a plain (non-JSON) message", () => {
    expect(parseStructuredChatError("Failed to fetch")).toBeNull();
  });
});
