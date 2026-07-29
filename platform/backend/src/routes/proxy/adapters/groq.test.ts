import { ArchestraInternalErrorCode, GroqErrorCodes } from "@archestra/shared";
import { describe, expect, test } from "@/test";
import { groqAdapterFactory } from "./groq";

/**
 * Groq's token-bucket error body, captured verbatim from a live rejection. The
 * transient 429 throttle carries an identical body — only the status differs,
 * which is why the classifier keys off it.
 */
function createTokenBucketError(status: number) {
  return {
    status,
    error: {
      message:
        "Request too large for model `llama-3.1-8b-instant` in organization `org_test` service tier `on_demand` on tokens per minute (TPM): Limit 6000, Requested 6719, please reduce your message size and try again.",
      type: "tokens",
      code: GroqErrorCodes.RATE_LIMIT_EXCEEDED,
    },
  };
}

describe("extractInternalCode", () => {
  test("classifies a 413 token-bucket rejection as RequestExceedsRateLimit", () => {
    expect(
      groqAdapterFactory.extractInternalCode(createTokenBucketError(413)),
    ).toBe(ArchestraInternalErrorCode.RequestExceedsRateLimit);
  });

  test("leaves the transient 429 throttle unclassified so it stays retryable", () => {
    // Identical body, different status: the bucket is momentarily empty rather
    // than too small, so this one really does clear on its own.
    expect(
      groqAdapterFactory.extractInternalCode(createTokenBucketError(429)),
    ).toBeUndefined();
  });

  test("reads the status from statusCode when that is where it lands", () => {
    const { status: _dropped, ...withoutStatus } = createTokenBucketError(413);
    expect(
      groqAdapterFactory.extractInternalCode({
        ...withoutStatus,
        statusCode: 413,
      }),
    ).toBe(ArchestraInternalErrorCode.RequestExceedsRateLimit);
  });

  test("still classifies the structured context_length_exceeded code", () => {
    const error = { error: { code: "context_length_exceeded" } };
    expect(groqAdapterFactory.extractInternalCode(error)).toBe(
      ArchestraInternalErrorCode.ContextLengthExceeded,
    );
  });

  test("leaves a 413 without the rate-limit code to the status mapper", () => {
    // A genuinely oversized body: RequestTooLarge ("compress or split
    // attachments") is the right advice there.
    const error = {
      status: 413,
      error: { message: "Request Entity Too Large", type: "invalid_request" },
    };
    expect(groqAdapterFactory.extractInternalCode(error)).toBeUndefined();
  });

  test("leaves an unrelated error unclassified", () => {
    const error = { error: { message: "invalid model specified" } };
    expect(groqAdapterFactory.extractInternalCode(error)).toBeUndefined();
  });
});
