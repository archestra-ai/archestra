import { describe, expect, test, vi } from "vitest";
import {
  detectRejectedSamplingParams,
  withSamplingParamFallback,
} from "./sampling-param-fallback";

describe("detectRejectedSamplingParams", () => {
  test("returns [] for non-object or non-rejection errors", () => {
    expect(detectRejectedSamplingParams(null)).toEqual([]);
    expect(detectRejectedSamplingParams(new Error("overloaded_error"))).toEqual(
      [],
    );
  });

  test("detects a deprecated temperature from the message", () => {
    expect(
      detectRejectedSamplingParams(
        new Error("`temperature` is deprecated for this model."),
      ),
    ).toEqual(["temperature"]);
  });

  test.each([
    "message",
    "responseBody",
  ])("detects Bedrock's temperature rejection from %s", (field) => {
    expect(
      detectRejectedSamplingParams({
        [field]:
          "This model doesn't support the temperature field. Remove temperature and try again.",
      }),
    ).toEqual(["temperature"]);
  });

  test("detects top_p across spellings and via the responseBody field", () => {
    expect(
      detectRejectedSamplingParams({ message: "top_p is not supported" }),
    ).toEqual(["top_p"]);
    // Bedrock's camelCase `topP`, lowercased, surfaced via responseBody.
    expect(
      detectRejectedSamplingParams({ responseBody: "topP is not allowed" }),
    ).toEqual(["top_p"]);
  });

  test("detects both params when both are named", () => {
    const result = detectRejectedSamplingParams(
      new Error("temperature and top_p are not supported for this model"),
    );
    expect(result).toEqual(expect.arrayContaining(["temperature", "top_p"]));
    expect(result).toHaveLength(2);
  });

  test("ignores a param named outside a rejection context", () => {
    expect(
      detectRejectedSamplingParams(new Error("temperature must be <= 1")),
    ).toEqual([]);
  });
});

describe("withSamplingParamFallback", () => {
  const rejection = new Error(
    "This model doesn't support the temperature field. Remove temperature and try again.",
  );

  function strip(input: { temperature?: number; maxTokens: number }) {
    if (input.temperature === undefined) return null;
    const { temperature: _temperature, ...rest } = input;
    return rest;
  }

  test("retries once without the rejected parameter and preserves the input", async () => {
    const input = { temperature: 0, maxTokens: 100 };
    const run = vi
      .fn()
      .mockRejectedValueOnce(rejection)
      .mockResolvedValue("summary");
    await expect(
      withSamplingParamFallback({ input, run, strip }),
    ).resolves.toBe("summary");
    expect(run.mock.calls).toEqual([[input], [{ maxTokens: 100 }]]);
    expect(input).toEqual({ temperature: 0, maxTokens: 100 });
  });

  test("does not repeat a rejected retry", async () => {
    const run = vi.fn().mockRejectedValue(rejection);
    await expect(
      withSamplingParamFallback({
        input: { temperature: 0, maxTokens: 100 },
        run,
        strip,
      }),
    ).rejects.toBe(rejection);
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("does not retry when the rejected parameter is absent", async () => {
    const run = vi.fn().mockRejectedValue(rejection);
    await expect(
      withSamplingParamFallback({ input: { maxTokens: 100 }, run, strip }),
    ).rejects.toBe(rejection);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
