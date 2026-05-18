import { ChatErrorCode, type ChatErrorResponse } from "@shared";
import { describe, expect, test } from "vitest";
import { __test } from "./conversation-chat-error";

const { normalizeChatErrorResponse } = __test;

describe("normalizeChatErrorResponse", () => {
  test("returns valid responses unchanged", () => {
    const input: ChatErrorResponse = {
      code: ChatErrorCode.RateLimit,
      message: "Slow down",
      isRetryable: true,
    };

    expect(normalizeChatErrorResponse(input)).toEqual(input);
  });

  test("coerces non-string originalError.message to a string", () => {
    const input = {
      code: ChatErrorCode.ServerError,
      message: "Boom",
      isRetryable: true,
      originalError: {
        message: { nested: "object" } as unknown as string,
      },
    } as ChatErrorResponse;

    const result = normalizeChatErrorResponse(input);

    expect(result.originalError?.message).toBe('{"nested":"object"}');
    expect(result.code).toBe(ChatErrorCode.ServerError);
  });

  test("falls back to a minimal valid response for non-enum code", () => {
    const input = {
      code: "not-a-real-code",
      message: "Custom",
      isRetryable: true,
    } as unknown as ChatErrorResponse;

    const result = normalizeChatErrorResponse(input);

    expect(result.code).toBe(ChatErrorCode.Unknown);
    expect(result.message).toBe("Custom");
    expect(result.isRetryable).toBe(false);
  });

  test("falls back when isRetryable is not a boolean", () => {
    const input = {
      code: ChatErrorCode.Unknown,
      message: "Hi",
      isRetryable: "yes",
    } as unknown as ChatErrorResponse;

    const result = normalizeChatErrorResponse(input);

    expect(result).toEqual({
      code: ChatErrorCode.Unknown,
      message: "Hi",
      isRetryable: false,
    });
  });

  test("stringifies top-level message when it isn't a string", () => {
    const input = {
      code: "bogus",
      message: { a: 1 },
      isRetryable: true,
    } as unknown as ChatErrorResponse;

    const result = normalizeChatErrorResponse(input);

    expect(result.code).toBe(ChatErrorCode.Unknown);
    expect(result.message).toContain('"a":1');
  });
});
