import { describe, expect, it } from "vitest";
import { aspectLockedPanelWidth } from "./resizable-right-panel";

describe("aspectLockedPanelWidth", () => {
  it("derives the width from the panel's own height at the locked ratio", () => {
    expect(
      aspectLockedPanelWidth({
        height: 960,
        ratio: 1 / 2,
        minWidth: 300,
        maxWidth: 900,
      }),
    ).toBe(480);
  });

  it("respects the same bounds user resizing does — a lock may demand a shape, never a squashed layout", () => {
    // Tall panel on a narrow window: the lock wants more width than the row
    // can give up without crushing the content column.
    expect(
      aspectLockedPanelWidth({
        height: 2000,
        ratio: 1 / 2,
        minWidth: 300,
        maxWidth: 700,
      }),
    ).toBe(700);
    // Short panel: the lock would shrink below the panel's own minimum.
    expect(
      aspectLockedPanelWidth({
        height: 400,
        ratio: 1 / 2,
        minWidth: 300,
        maxWidth: 900,
      }),
    ).toBe(300);
  });
});
