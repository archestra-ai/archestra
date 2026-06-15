import { describe, expect, it } from "vitest";
import {
  clampInlineHeight,
  INLINE_VIEWPORT_FRACTION,
  inlineCeilingFor,
  MIN_INLINE_CEILING,
} from "./app-height";

describe("inlineCeilingFor", () => {
  it("scales with the viewport fraction on tall viewports", () => {
    expect(inlineCeilingFor(1000)).toBe(
      Math.round(1000 * INLINE_VIEWPORT_FRACTION),
    );
    expect(inlineCeilingFor(1000)).toBeGreaterThan(MIN_INLINE_CEILING);
  });

  it("floors at MIN_INLINE_CEILING on short viewports", () => {
    expect(inlineCeilingFor(100)).toBe(MIN_INLINE_CEILING);
    expect(inlineCeilingFor(0)).toBe(MIN_INLINE_CEILING);
  });
});

describe("clampInlineHeight", () => {
  it("passes through a height below the ceiling", () => {
    expect(clampInlineHeight(200, 600)).toBe(200);
  });

  it("clamps a height above the ceiling", () => {
    expect(clampInlineHeight(100_000, 600)).toBe(600);
  });

  it("handles the equal and zero edges", () => {
    expect(clampInlineHeight(600, 600)).toBe(600);
    expect(clampInlineHeight(0, 600)).toBe(0);
    expect(clampInlineHeight(-50, 600)).toBe(0);
  });
});
