// @vitest-environment node
import type { ContextWindowBreakdown } from "@archestra/shared";
import { describe, expect, it } from "vitest";
import {
  AUTO_COMPACT_PERCENT,
  autoCompactProgressPercent,
  getContextWindowStatus,
  reconcileContextWindowBreakdown,
  resolveContextWindowUsage,
} from "./context-window-status";

describe("getContextWindowStatus", () => {
  it("reports headroom to auto-compaction, not to a full window", () => {
    // 37% used against an 80% trigger leaves 43 points of the window — the
    // number the indicator quotes, and deliberately not 63%.
    const status = getContextWindowStatus(370_000, 1_000_000);

    expect(status.usedPercent).toBeCloseTo(37);
    expect(status.remainingPercent).toBeCloseTo(43);
  });

  it("floors remaining headroom at zero once past the trigger", () => {
    const status = getContextWindowStatus(950_000, 1_000_000);

    expect(status.remainingPercent).toBe(0);
    expect(status.atAutoCompact).toBe(true);
  });

  it("treats the trigger itself as at-auto-compact", () => {
    const status = getContextWindowStatus(800_000, 1_000_000);

    expect(status.usedPercent).toBeCloseTo(AUTO_COMPACT_PERCENT);
    expect(status.atAutoCompact).toBe(true);
    expect(status.remainingPercent).toBe(0);
  });

  it("flags the band where compacting is worth offering before it is forced", () => {
    const approaching = getContextWindowStatus(760_000, 1_000_000);
    const comfortable = getContextWindowStatus(400_000, 1_000_000);

    expect(approaching.nearAutoCompact).toBe(true);
    expect(approaching.atAutoCompact).toBe(false);
    expect(comfortable.nearAutoCompact).toBe(false);
  });

  it("caps usage at 100% when the estimate overshoots the window", () => {
    const status = getContextWindowStatus(1_400_000, 1_000_000);

    expect(status.usedPercent).toBe(100);
    expect(status.remainingPercent).toBe(0);
  });

  it("fills the countdown gauge against the trigger, not the whole window", () => {
    // 40% of a window used is only halfway to an 80% trigger — the gauge
    // beside the headroom sentence counts down to that event, so it must not
    // read 40% like the composer's usage ring does.
    const status = getContextWindowStatus(400_000, 1_000_000);

    expect(status.usedPercent).toBeCloseTo(40);
    expect(autoCompactProgressPercent(status)).toBeCloseTo(50);
  });

  it("fills the countdown gauge completely once auto-compaction is due", () => {
    expect(
      autoCompactProgressPercent(getContextWindowStatus(800_000, 1_000_000)),
    ).toBe(100);
    // And stays full rather than overflowing past the trigger.
    expect(
      autoCompactProgressPercent(getContextWindowStatus(990_000, 1_000_000)),
    ).toBe(100);
  });

  it("reports no pressure rather than dividing by an unknown window", () => {
    // Callers suppress the headroom copy entirely in this case; the point here
    // is that an unknown window never reads as *near* auto-compaction.
    const status = getContextWindowStatus(50_000, null);

    expect(status.usedPercent).toBe(0);
    expect(status.atAutoCompact).toBe(false);
    expect(status.nearAutoCompact).toBe(false);
  });
});

function sampleBreakdown(
  overrides: Partial<ContextWindowBreakdown> = {},
): ContextWindowBreakdown {
  return {
    provider: "openai",
    model: "gpt-4.1",
    contextLength: 328_000,
    usedTokens: 9_700,
    freeTokens: 318_300,
    usedPercent: 2.957,
    estimatedInputCostUsd: 0.02,
    segments: [
      { category: "system_prompt", tokens: 1_700 },
      {
        category: "messages",
        tokens: 8_000,
        items: [{ label: "You: hello", tokens: 8_000 }],
      },
    ],
    ...overrides,
  };
}

describe("resolveContextWindowUsage", () => {
  it("prefers the live tokensUsed and currently selected model's maxTokens over stale breakdown values", () => {
    // Switching from a 328k model to a 16.4k model (e.g. gpt-3.5-turbo-0613)
    // or receiving a refined post-step token count must keep the indicator and
    // tooltip on the same active numbers.
    const resolved = resolveContextWindowUsage({
      tokensUsed: 9_700,
      maxTokens: 16_385,
      breakdown: sampleBreakdown({
        usedTokens: 9_700,
        contextLength: 328_000,
      }),
    });

    expect(resolved).toEqual({
      tokensUsed: 9_700,
      maxTokens: 16_385,
    });
  });

  it("falls back to breakdown values when live tokensUsed or maxTokens is absent", () => {
    const resolved = resolveContextWindowUsage({
      tokensUsed: 0,
      maxTokens: null,
      breakdown: sampleBreakdown({
        usedTokens: 9_700,
        contextLength: 328_000,
      }),
    });

    expect(resolved).toEqual({
      tokensUsed: 9_700,
      maxTokens: 328_000,
    });
  });
});

describe("reconcileContextWindowBreakdown", () => {
  it("returns the same reference when usedTokens and contextLength already match", () => {
    const breakdown = sampleBreakdown();
    expect(
      reconcileContextWindowBreakdown(breakdown, {
        tokensUsed: 9_700,
        maxTokens: 328_000,
      }),
    ).toBe(breakdown);
  });

  it("recomputes freeTokens and usedPercent when the selected model's maxTokens changes", () => {
    const reconciled = reconcileContextWindowBreakdown(sampleBreakdown(), {
      tokensUsed: 9_700,
      maxTokens: 16_385,
    });

    expect(reconciled.contextLength).toBe(16_385);
    expect(reconciled.usedTokens).toBe(9_700);
    expect(reconciled.freeTokens).toBe(16_385 - 9_700);
    expect(reconciled.usedPercent).toBeCloseTo((9_700 / 16_385) * 100);
  });

  it("scales segments and cost proportionally when tokensUsed is refined", () => {
    const reconciled = reconcileContextWindowBreakdown(sampleBreakdown(), {
      tokensUsed: 19_400,
    });

    expect(reconciled.usedTokens).toBe(19_400);
    expect(reconciled.freeTokens).toBe(328_000 - 19_400);
    expect(reconciled.estimatedInputCostUsd).toBeCloseTo(0.04);
    expect(reconciled.segments.map((s) => s.tokens)).toEqual([3_400, 16_000]);
    expect(reconciled.segments[1]?.items?.[0]?.tokens).toBe(16_000);
  });

  it("distributes rounding remainder to the largest segment so segment sum equals usedTokens", () => {
    const breakdown = sampleBreakdown({
      usedTokens: 1_000,
      segments: [
        { category: "system_prompt", tokens: 333 },
        { category: "tools", tokens: 333 },
        { category: "messages", tokens: 334 },
      ],
    });
    const reconciled = reconcileContextWindowBreakdown(breakdown, {
      tokensUsed: 1_001,
    });

    const segmentSum = reconciled.segments.reduce(
      (sum, s) => sum + s.tokens,
      0,
    );
    expect(segmentSum).toBe(1_001);
    expect(reconciled.segments.map((s) => s.tokens)).toEqual([333, 333, 335]);
  });
});
