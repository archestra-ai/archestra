import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReinstallConfirmBar } from "./reinstall-confirm-bar";

describe("ReinstallConfirmBar", () => {
  beforeEach(() => {
    // The bar scrolls itself into view on mount; jsdom has no such method.
    Element.prototype.scrollIntoView = vi.fn();
  });

  function renderBar() {
    render(
      <ReinstallConfirmBar
        mode="rename"
        newName="Nimbus Notes"
        affectedServerCount={1}
        isSubmitting={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    const footer = screen
      .getByRole("button", { name: "Save and rename" })
      .closest('[data-slot="dialog-footer"]');
    expect(footer).not.toBeNull();
    return footer as HTMLElement;
  }

  /**
   * Regression: `cn()` is tailwind-merge, so the bar's own background class
   * merges against — and wins over — DialogStickyFooter's. Tinting the bar
   * with a plain `bg-amber-…/40` therefore dropped the footer's opaque
   * `bg-background` entirely, and this sticky bar rendered translucent: the
   * form scrolling underneath it read straight through the warning text.
   * The opaque backdrop has to survive whatever the bar layers on top.
   */
  it("keeps an opaque backdrop under its warning tint", () => {
    const classes = Array.from(renderBar().classList);

    // The element's own background is the bottom-most layer — nothing paints
    // beneath it — so it is the one layer that may not be translucent. The
    // bar keeps it clear and tints through `after:` instead.
    expect(classes.filter((c) => /^(dark:)?bg-/.test(c))).toEqual([]);
    expect(classes).toContain("before:bg-background");
  });
});
