// Unit tests for the OpenAI reasoning-summary capability gate: the
// verification-rejection detector that drives the strip-retry recovery, the
// per-credential cache key, and the cache helpers' degrade-don't-fail
// contract.

import { describe, expect, test } from "@/test";
import {
  isOpenAiReasoningSummaryMarkedUnsupported,
  isReasoningSummaryVerificationError,
  markOpenAiReasoningSummaryUnsupported,
  openAiReasoningSummaryCacheKey,
} from "./openai-reasoning-summary";

const VERIFICATION_MESSAGE =
  "Your organization must be verified to generate reasoning summaries. Please go to: https://platform.openai.com/settings/organization/general and click on Verify Organization.";

describe("isReasoningSummaryVerificationError", () => {
  test("matches the rejection in the error message", () => {
    expect(
      isReasoningSummaryVerificationError(new Error(VERIFICATION_MESSAGE)),
    ).toBe(true);
  });

  test("matches the rejection carried only in an APICallError-style responseBody", () => {
    const error = Object.assign(new Error("Bad Request"), {
      responseBody: JSON.stringify({
        error: {
          message: VERIFICATION_MESSAGE,
          type: "invalid_request_error",
          param: null,
          code: null,
        },
      }),
    });
    expect(isReasoningSummaryVerificationError(error)).toBe(true);
  });

  test("matches a reworded 400 that still blames the reasoning.summary param in the responseBody", () => {
    const error = Object.assign(new Error("Bad Request"), {
      responseBody:
        '{"error":{"message":"Unsupported parameter for this model.","type":"invalid_request_error","param":"reasoning.summary","code":null}}',
    });
    expect(isReasoningSummaryVerificationError(error)).toBe(true);
  });

  test("matches a reworded 400 that blames the reasoning.summary param in the parsed error data", () => {
    const error = Object.assign(new Error("Bad Request"), {
      data: {
        error: {
          message: "Unsupported parameter for this model.",
          param: "reasoning.summary",
        },
      },
    });
    expect(isReasoningSummaryVerificationError(error)).toBe(true);
  });

  test("matches a rejection nested under an SDK wrapper's cause chain", () => {
    const wrapped = new Error("Stream processing failed", {
      cause: new Error("Failed after 1 attempt", {
        cause: new Error(VERIFICATION_MESSAGE),
      }),
    });
    expect(isReasoningSummaryVerificationError(wrapped)).toBe(true);
  });

  test("terminates on a self-referential cause chain without matching", () => {
    const cyclic = new Error("Bad Request");
    (cyclic as Error & { cause: unknown }).cause = cyclic;
    expect(isReasoningSummaryVerificationError(cyclic)).toBe(false);
  });

  test("rejects unrelated errors, other offending params, and non-object errors", () => {
    expect(
      isReasoningSummaryVerificationError(
        new Error(
          "You exceeded your current quota, please check your plan and billing details.",
        ),
      ),
    ).toBe(false);
    expect(
      isReasoningSummaryVerificationError(
        Object.assign(new Error("Bad Request"), {
          data: { error: { param: "temperature" } },
        }),
      ),
    ).toBe(false);
    expect(isReasoningSummaryVerificationError(VERIFICATION_MESSAGE)).toBe(
      false,
    );
    expect(isReasoningSummaryVerificationError(null)).toBe(false);
    expect(isReasoningSummaryVerificationError(undefined)).toBe(false);
  });
});

describe("openAiReasoningSummaryCacheKey", () => {
  test("keys the verdict by organization and resolved credential", () => {
    expect(
      openAiReasoningSummaryCacheKey({
        organizationId: "org-1",
        llmApiKeyId: "key-1",
      }),
    ).toBe("openai-reasoning-summary-unsupported-org-1:key-1");
    // environment-variable keys have no credential row; they share one slot
    expect(
      openAiReasoningSummaryCacheKey({
        organizationId: "org-1",
        llmApiKeyId: null,
      }),
    ).toBe("openai-reasoning-summary-unsupported-org-1:env");
  });
});

describe("cache verdict helpers", () => {
  // Both helpers must degrade rather than fail the turn: an unavailable or
  // unmarked cache reads as "summaries supported", and a failed verdict write
  // resolves anyway (it only costs one wasted round-trip on a later turn).
  test("an unmarked credential reads as not-unsupported", async () => {
    const key = openAiReasoningSummaryCacheKey({
      organizationId: "org-never-marked",
      llmApiKeyId: null,
    });
    await expect(isOpenAiReasoningSummaryMarkedUnsupported(key)).resolves.toBe(
      false,
    );
  });

  test("marking a credential never rejects", async () => {
    const key = openAiReasoningSummaryCacheKey({
      organizationId: "org-never-marked",
      llmApiKeyId: null,
    });
    await expect(
      markOpenAiReasoningSummaryUnsupported(key),
    ).resolves.toBeUndefined();
  });
});
