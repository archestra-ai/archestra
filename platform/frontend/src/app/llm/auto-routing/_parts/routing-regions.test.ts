import { describe, expect, it } from "vitest";
import { isoFastGuide, type Point, warp } from "./routing-regions";

/** Distance from `p` to the segment `[a, b]`. */
function offSegment(p: Point, [a, b]: readonly [Point, Point]): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const t = Math.max(
    0,
    Math.min(
      1,
      ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy),
    ),
  );
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

describe("warp", () => {
  it("keeps the triangle's vertices", () => {
    expect(warp([0, 0])).toEqual([0, 0]);
    expect(warp([1, 0])).toEqual([1, 0]);
    expect(warp([0, 1])).toEqual([0, 1]);
  });

  it("puts a near-hypotenuse point √p_fast deep, keeping p_normal : p_smart", () => {
    const pFast = 1e-6;
    const [x, y] = warp([0.6 * (1 - pFast), 0.4 * (1 - pFast)]);

    expect(1 - x - y).toBeCloseTo(Math.sqrt(pFast), 12);
    expect(x / y).toBeCloseTo(0.6 / 0.4, 12);
  });
});

describe("isoFastGuide", () => {
  it.each([
    1e-6, 0.01, 0.1, 0.5,
  ])("runs through every point with p_fast = %s, leg to leg", (pFast) => {
    const guide = isoFastGuide(pFast);
    for (const share of [0, 0.1, 0.37, 0.5, 0.9, 1]) {
      const rest = 1 - pFast;
      const at = warp([rest * share, rest * (1 - share)]);
      expect(offSegment(at, guide)).toBeLessThan(1e-12);
    }
    expect(guide[0][1]).toBe(0);
    expect(guide[1][0]).toBe(0);
  });
});
