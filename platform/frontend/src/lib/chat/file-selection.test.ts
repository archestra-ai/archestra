import { describe, expect, it } from "vitest";
import {
  pruneSelectedIds,
  selectAllIds,
  selectionCheckState,
  toggleSelectedId,
} from "@/lib/chat/file-selection";

describe("toggleSelectedId", () => {
  it("adds an absent id and removes a present one (new set each time)", () => {
    const a = toggleSelectedId(new Set<string>(), "x");
    expect([...a]).toEqual(["x"]);
    const b = toggleSelectedId(a, "x");
    expect([...b]).toEqual([]);
    expect(b).not.toBe(a);
  });
});

describe("selectAllIds", () => {
  it("selects all when not all checked, clears when all checked", () => {
    expect([...selectAllIds(false, ["a", "b"])]).toEqual(["a", "b"]);
    expect([...selectAllIds(true, ["a", "b"])]).toEqual([]);
  });
});

describe("pruneSelectedIds", () => {
  it("drops ids no longer present", () => {
    expect([...pruneSelectedIds(new Set(["a", "gone"]), ["a", "b"])]).toEqual([
      "a",
    ]);
  });

  it("returns the same reference when nothing changed", () => {
    const sel = new Set(["a"]);
    expect(pruneSelectedIds(sel, ["a", "b"])).toBe(sel);
    expect(pruneSelectedIds(new Set(), ["a"])).toBeInstanceOf(Set);
  });
});

describe("selectionCheckState", () => {
  it("derives all/some checked", () => {
    expect(selectionCheckState(0, 3)).toEqual({
      allChecked: false,
      someChecked: false,
    });
    expect(selectionCheckState(2, 3)).toEqual({
      allChecked: false,
      someChecked: true,
    });
    expect(selectionCheckState(3, 3)).toEqual({
      allChecked: true,
      someChecked: false,
    });
    expect(selectionCheckState(0, 0)).toEqual({
      allChecked: false,
      someChecked: false,
    });
  });
});
