import type {
  ContextWindowBreakdown,
  ContextWindowSegment,
} from "@archestra/shared";
import { describe, expect, it } from "vitest";
import {
  assertWithinContextWindow,
  ContextWindowExceededError,
} from "./enforce-context-window-limit";

function makeBreakdown(params: {
  contextLength: number | null;
  segments: ContextWindowSegment[];
}): ContextWindowBreakdown {
  const usedTokens = params.segments.reduce((sum, s) => sum + s.tokens, 0);
  return {
    provider: "openai",
    model: "gpt-test",
    contextLength: params.contextLength,
    usedTokens,
    freeTokens:
      params.contextLength === null ? null : params.contextLength - usedTokens,
    usedPercent: null,
    estimatedInputCostUsd: null,
    segments: params.segments,
  };
}

describe("assertWithinContextWindow", () => {
  it("throws when tokenizer-counted tokens exceed the window", () => {
    const breakdown = makeBreakdown({
      contextLength: 200,
      segments: [
        { category: "system_prompt", tokens: 50 },
        { category: "messages", tokens: 300 },
      ],
    });

    let thrown: unknown;
    try {
      assertWithinContextWindow(breakdown);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ContextWindowExceededError);
    const error = thrown as ContextWindowExceededError;
    expect(error.contextLength).toBe(200);
    expect(error.estimatedTokens).toBe(350);
    expect(error.model).toBe("gpt-test");
  });

  it("does not throw when only the heuristic files segment pushes over the window", () => {
    // messages (100) fit; files (500) are a byte-ratio heuristic and must not
    // trigger a hard reject even though usedTokens (600) exceeds the window.
    const breakdown = makeBreakdown({
      contextLength: 200,
      segments: [
        { category: "messages", tokens: 100 },
        { category: "files", tokens: 500 },
      ],
    });

    expect(() => assertWithinContextWindow(breakdown)).not.toThrow();
  });

  it("does not throw when the request fits", () => {
    const breakdown = makeBreakdown({
      contextLength: 200,
      segments: [{ category: "messages", tokens: 50 }],
    });

    expect(() => assertWithinContextWindow(breakdown)).not.toThrow();
  });

  it("does not throw when the context length is unknown", () => {
    const breakdown = makeBreakdown({
      contextLength: null,
      segments: [{ category: "messages", tokens: 10_000 }],
    });

    expect(() => assertWithinContextWindow(breakdown)).not.toThrow();
  });
});
