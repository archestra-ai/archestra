import { afterEach, describe, expect, it, vi } from "vitest";
import { openRowOnPlainClick } from "./row-click-shield";

const plainClick = {
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openRowOnPlainClick", () => {
  it("opens the row on a plain click", () => {
    const open = vi.fn();
    openRowOnPlainClick(plainClick, open);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("leaves a modified click to the browser and the row's name link", () => {
    for (const modifier of [
      "metaKey",
      "ctrlKey",
      "shiftKey",
      "altKey",
    ] as const) {
      const open = vi.fn();
      openRowOnPlainClick({ ...plainClick, [modifier]: true }, open);
      expect(open, modifier).not.toHaveBeenCalled();
    }
  });

  it("does not navigate away from text the click has just finished selecting", () => {
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: false,
    } as Selection);
    const open = vi.fn();
    openRowOnPlainClick(plainClick, open);
    expect(open).not.toHaveBeenCalled();
  });

  it("opens the row when the selection is only a caret", () => {
    vi.spyOn(window, "getSelection").mockReturnValue({
      isCollapsed: true,
    } as Selection);
    const open = vi.fn();
    openRowOnPlainClick(plainClick, open);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
