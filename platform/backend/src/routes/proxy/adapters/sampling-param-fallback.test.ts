import { describe, expect, test } from "vitest";
import { detectRejectedSamplingParams } from "./sampling-param-fallback";

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
