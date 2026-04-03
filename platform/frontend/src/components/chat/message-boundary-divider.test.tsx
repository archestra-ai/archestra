import { describe, expect, it } from "vitest";
import { shouldShowStickyBoundaryIndicator } from "./message-boundary-divider";

describe("shouldShowStickyBoundaryIndicator", () => {
  it("returns true when the boundary has scrolled above the top of the container", () => {
    expect(
      shouldShowStickyBoundaryIndicator({
        boundaryTop: 80,
        boundaryBottom: 90,
        containerTop: 100,
      }),
    ).toBe(true);
  });

  it("returns false while the boundary is still visible in the container", () => {
    expect(
      shouldShowStickyBoundaryIndicator({
        boundaryTop: 120,
        boundaryBottom: 140,
        containerTop: 100,
      }),
    ).toBe(false);
  });
});
