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

  describe("Ollama providers (unknown output ceiling)", () => {
    for (const provider of ["ollama", "ollama-native"] as const) {
      test(`${provider}: derives the budget from the context window, not 8192`, () => {
        // `num_predict` is drawn from the same `num_ctx` window as the prompt,
        // so the fallback lands on half the window rather than all of it.
        expect(
          resolveAgentMaxOutputTokens({
            outputLength: null,
            ceiling,
            provider,
            contextLength: 40960,
          }),
        ).toBe(20480);
      });

      test(`${provider}: the operator ceiling still caps the context fallback`, () => {
        expect(
          resolveAgentMaxOutputTokens({
            outputLength: null,
            ceiling,
            provider,
            contextLength: 262144,
          }),
        ).toBe(ceiling);
      });

      test(`${provider}: a real output ceiling still wins over the context window`, () => {
        expect(
          resolveAgentMaxOutputTokens({
            outputLength: 4096,
            ceiling,
            provider,
            contextLength: 262144,
          }),
        ).toBe(4096);
      });

      test(`${provider}: unknown context still falls back to 8192`, () => {
        expect(
          resolveAgentMaxOutputTokens({
            outputLength: null,
            ceiling,
            provider,
            contextLength: null,
          }),
        ).toBe(UNKNOWN_MODEL_OUTPUT_TOKENS);
      });
    }

    test("non-Ollama providers keep the 8192 fallback even with a context length", () => {
      expect(
        resolveAgentMaxOutputTokens({
          outputLength: null,
          ceiling,
          provider: "openai",
          contextLength: 128000,
        }),
      ).toBe(UNKNOWN_MODEL_OUTPUT_TOKENS);
    });

    test("an invalid context window falls back rather than propagating", () => {
      // A 0, negative or fractional window would otherwise become the output
      // budget — and, once folded into `options.num_predict`, cap every
      // generation at a nonsense length.
      for (const contextLength of [
        0,
        -1,
        8192.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]) {
        expect(
          resolveAgentMaxOutputTokens({
            outputLength: null,
            ceiling,
            provider: "ollama-native",
            contextLength,
          }),
        ).toBe(UNKNOWN_MODEL_OUTPUT_TOKENS);
      }
    });
  });

  test("caps shared-window models at half the context so the prompt has room", () => {
    // gpt-4: output 8192 == context 8192 — requesting the full output ceiling
    // would consume the entire window and 400 on every request.
    expect(
      resolveAgentMaxOutputTokens({
        outputLength: 8192,
        contextLength: 8192,
        ceiling,
      }),
    ).toBe(4096);
  });

  test("the shared-window cap never binds for modern large-context models", () => {
    expect(
      resolveAgentMaxOutputTokens({
        outputLength: 128000,
        contextLength: 400000,
        ceiling: 200000,
      }),
    ).toBe(128000);
  });

  test("an unknown context window leaves the budget unchanged", () => {
    expect(
      resolveAgentMaxOutputTokens({
        outputLength: 8192,
        contextLength: null,
        ceiling,
      }),
    ).toBe(8192);
  });

  test("an invalid context window is treated as unknown", () => {
    expect(
      resolveAgentMaxOutputTokens({
        outputLength: 8192,
        contextLength: 0,
        ceiling,
      }),
    ).toBe(8192);
  });
});
