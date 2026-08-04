import { describe, expect, it } from "vitest";
import {
  AUTO_COMPACT_PERCENT,
  autoCompactProgressPercent,
  getContextWindowStatus,
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
