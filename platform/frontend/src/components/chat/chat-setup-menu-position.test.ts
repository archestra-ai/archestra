// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getChatSetupMenuPosition } from "./chat-setup-menu-position";

describe("getChatSetupMenuPosition", () => {
  it("prefers below a centered composer even when there is more room above", () => {
    const position = getChatSetupMenuPosition({
      triggerTop: 500,
      triggerBottom: 532,
      viewportTop: 0,
      viewportHeight: 1000,
    });
    expect(position.side).toBe("bottom");
    // The menu, border, gap and viewport padding must all fit below the trigger.
    expect(position.maxHeight + 532 + 22).toBe(1000);
  });

  it("uses the space above when a composer near the bottom leaves too little room", () => {
    expect(
      getChatSetupMenuPosition({
        triggerTop: 800,
        triggerBottom: 832,
        viewportTop: 0,
        viewportHeight: 1000,
      }),
    ).toEqual({ side: "top", maxHeight: 778 });
  });

  it("accounts for a shifted visual viewport when the mobile keyboard is open", () => {
    expect(
      getChatSetupMenuPosition({
        triggerTop: 260,
        triggerBottom: 292,
        viewportTop: 180,
        viewportHeight: 400,
      }),
    ).toEqual({ side: "bottom", maxHeight: 266 });
  });

  it("uses the larger side in a constrained viewport instead of forcing a tiny upper list", () => {
    expect(
      getChatSetupMenuPosition({
        triggerTop: 100,
        triggerBottom: 132,
        viewportTop: 0,
        viewportHeight: 320,
      }),
    ).toEqual({ side: "bottom", maxHeight: 166 });
  });

  it("never produces a negative height while the trigger is outside the visual viewport", () => {
    const position = getChatSetupMenuPosition({
      triggerTop: 0,
      triggerBottom: 32,
      viewportTop: 10,
      viewportHeight: 10,
    });
    expect(position.maxHeight).toBe(0);
  });
});
