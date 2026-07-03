import { describe, expect, test } from "@/test";
import { resolveAgentMaxOutputTokens } from "./agent-output-budget";

// The documented fallback budget for a model whose real output ceiling is unknown.
const UNKNOWN_MODEL_OUTPUT_TOKENS = 8192;

describe("resolveAgentMaxOutputTokens", () => {
  const ceiling = 32768;

  test("uses the model's real output ceiling when it fits under the ceiling", () => {
    expect(resolveAgentMaxOutputTokens({ outputLength: 8192, ceiling })).toBe(
      8192,
    );
  });

  test("clamps a large real ceiling down to the operator ceiling", () => {
    expect(resolveAgentMaxOutputTokens({ outputLength: 64000, ceiling })).toBe(
      32768,
    );
  });

  test("keeps a small legacy cap (4096) intact", () => {
    expect(resolveAgentMaxOutputTokens({ outputLength: 4096, ceiling })).toBe(
      4096,
    );
  });

  test("falls back to the unknown-model budget when outputLength is null", () => {
    expect(resolveAgentMaxOutputTokens({ outputLength: null, ceiling })).toBe(
      UNKNOWN_MODEL_OUTPUT_TOKENS,
    );
  });

  test("treats invalid outputLength as unknown", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveAgentMaxOutputTokens({ outputLength: bad, ceiling })).toBe(
        UNKNOWN_MODEL_OUTPUT_TOKENS,
      );
    }
  });

  test("a lower operator ceiling also caps the unknown-model fallback", () => {
    expect(
      resolveAgentMaxOutputTokens({ outputLength: null, ceiling: 4096 }),
    ).toBe(4096);
  });
});
