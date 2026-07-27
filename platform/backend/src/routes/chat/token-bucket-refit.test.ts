import { describe, expect, test } from "@/test";
import {
  parseTokenBucketError,
  refitOutputBudgetToTokenBucket,
} from "./token-bucket-refit";

/** The rejection body as it reaches the stream, captured from a live 413. */
function tokenBucketBody(params: { limit: number; requested: number }) {
  return {
    responseBody: JSON.stringify({
      error: {
        message: `Request too large for model \`llama-3.1-8b-instant\` in organization \`org_test\` service tier \`on_demand\` on tokens per minute (TPM): Limit ${params.limit}, Requested ${params.requested}, please reduce your message size and try again.`,
        type: "api_payload_too_large_error",
      },
    }),
  };
}

describe("parseTokenBucketError", () => {
  test("reads the allowance and the rejected request size", () => {
    expect(
      parseTokenBucketError(tokenBucketBody({ limit: 6000, requested: 6719 })),
    ).toEqual({ limitTokens: 6000, requestedTokens: 6719 });
  });

  test("reads it off a plain Error message too", () => {
    expect(
      parseTokenBucketError(
        new Error(
          "on tokens per minute (TPM): Limit 12000, Requested 35421, please reduce your message size",
        ),
      ),
    ).toEqual({ limitTokens: 12000, requestedTokens: 35421 });
  });

  test("ignores a tokens-per-day rejection", () => {
    // A daily budget is not recoverable by shrinking one turn's output.
    expect(
      parseTokenBucketError(
        new Error("on tokens per day (TPD): Limit 500000, Requested 6719"),
      ),
    ).toBeNull();
  });

  test("ignores unrelated errors", () => {
    expect(parseTokenBucketError(new Error("model not found"))).toBeNull();
    expect(parseTokenBucketError(undefined)).toBeNull();
  });
});

describe("refitOutputBudgetToTokenBucket", () => {
  test("fits the budget into the room the prompt leaves", () => {
    // The reproduced failure: prompt 2623 = 6719 requested - 4096 reserved,
    // leaving 3377 of the 6000 bucket; 90% of that is 3039.
    expect(
      refitOutputBudgetToTokenBucket({
        bucket: { limitTokens: 6000, requestedTokens: 6719 },
        currentMaxOutputTokens: 4096,
      }),
    ).toBe(3039);
  });

  test("the refitted request fits under the reported limit", () => {
    const bucket = { limitTokens: 6000, requestedTokens: 6719 };
    const currentMaxOutputTokens = 4096;
    const refitted = refitOutputBudgetToTokenBucket({
      bucket,
      currentMaxOutputTokens,
    });
    const promptTokens = bucket.requestedTokens - currentMaxOutputTokens;
    expect(promptTokens + (refitted ?? 0)).toBeLessThan(bucket.limitTokens);
  });

  test("declines when the prompt alone leaves no usable room", () => {
    // Prompt is 5900 of a 6000 bucket: any retry would be pointlessly truncated.
    expect(
      refitOutputBudgetToTokenBucket({
        bucket: { limitTokens: 6000, requestedTokens: 9996 },
        currentMaxOutputTokens: 4096,
      }),
    ).toBeNull();
  });

  test("declines when the prompt already exceeds the bucket", () => {
    expect(
      refitOutputBudgetToTokenBucket({
        bucket: { limitTokens: 6000, requestedTokens: 20000 },
        currentMaxOutputTokens: 4096,
      }),
    ).toBeNull();
  });

  test("declines when the reservation was evidently not counted", () => {
    // Requested is smaller than our own reservation, so the budget is not what
    // blew the limit and shrinking it would change nothing.
    expect(
      refitOutputBudgetToTokenBucket({
        bucket: { limitTokens: 6000, requestedTokens: 1000 },
        currentMaxOutputTokens: 4096,
      }),
    ).toBeNull();
  });

  test("declines when the refit would not shrink the request", () => {
    expect(
      refitOutputBudgetToTokenBucket({
        bucket: { limitTokens: 100000, requestedTokens: 6719 },
        currentMaxOutputTokens: 4096,
      }),
    ).toBeNull();
  });
});
