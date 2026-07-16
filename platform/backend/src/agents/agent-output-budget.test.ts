import { describe, expect, test } from "@/test";
import { resolveAgentMaxOutputTokens } from "./agent-output-budget";

// The documented fallback budget for a model whose real output ceiling is unknown.
const UNKNOWN_MODEL_OUTPUT_TOKENS = 8192;

describe("resolveAgentMaxOutputTokens", () => {
  const ceiling = 32768;

  test("uses the model's real output ceiling when it fits under the ceiling", () => {
    expect(
      resolveAgentMaxOutputTokens({
        provider: "anthropic",
        outputLength: 8192,
        contextLength: null,
        ceiling,
      }),
    ).toBe(8192);
  });

  test("clamps a large real ceiling down to the operator ceiling", () => {
    expect(
      resolveAgentMaxOutputTokens({
        provider: "anthropic",
        outputLength: 64000,
        contextLength: null,
        ceiling,
      }),
    ).toBe(32768);
  });

  test("keeps a small legacy cap (4096) intact", () => {
    expect(
      resolveAgentMaxOutputTokens({
        provider: "anthropic",
        outputLength: 4096,
        contextLength: null,
        ceiling,
      }),
    ).toBe(4096);
  });

  test("falls back to the unknown-model budget when outputLength is null", () => {
    expect(
      resolveAgentMaxOutputTokens({
        provider: "anthropic",
        outputLength: null,
        contextLength: null,
        ceiling,
      }),
    ).toBe(UNKNOWN_MODEL_OUTPUT_TOKENS);
  });

  test("treats invalid outputLength as unknown", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        resolveAgentMaxOutputTokens({
          provider: "anthropic",
          outputLength: bad,
          contextLength: null,
          ceiling,
        }),
      ).toBe(UNKNOWN_MODEL_OUTPUT_TOKENS);
    }
  });

  test("a lower operator ceiling also caps the unknown-model fallback", () => {
    expect(
      resolveAgentMaxOutputTokens({
        provider: "anthropic",
        outputLength: null,
        contextLength: null,
        ceiling: 4096,
      }),
    ).toBe(4096);
  });

  test("ollama with unknown output falls back to the context window, clamped by the ceiling", () => {
    expect(
      resolveAgentMaxOutputTokens({
        provider: "ollama",
        outputLength: null,
        contextLength: 131072,
        ceiling,
      }),
    ).toBe(32768);
  });

  test("ollama context window below the unknown-model budget is the honest cap", () => {
    expect(
      resolveAgentMaxOutputTokens({
        provider: "ollama",
        outputLength: null,
        contextLength: 4096,
        ceiling,
      }),
    ).toBe(4096);
  });

  test("ollama without a context window keeps the unknown-model budget", () => {
    expect(
      resolveAgentMaxOutputTokens({
        provider: "ollama",
        outputLength: null,
        contextLength: null,
        ceiling,
      }),
    ).toBe(UNKNOWN_MODEL_OUTPUT_TOKENS);
  });

  test("ollama with a real output ceiling ignores the context-window fallback", () => {
    expect(
      resolveAgentMaxOutputTokens({
        provider: "ollama",
        outputLength: 16000,
        contextLength: 131072,
        ceiling,
      }),
    ).toBe(16000);
  });

  test("the context-window fallback is ollama-only", () => {
    expect(
      resolveAgentMaxOutputTokens({
        provider: "anthropic",
        outputLength: null,
        contextLength: 200000,
        ceiling,
      }),
    ).toBe(UNKNOWN_MODEL_OUTPUT_TOKENS);
  });

  test("ollama treats an invalid context window as unknown", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        resolveAgentMaxOutputTokens({
          provider: "ollama",
          outputLength: null,
          contextLength: bad,
          ceiling,
        }),
      ).toBe(UNKNOWN_MODEL_OUTPUT_TOKENS);
    }
  });
});
