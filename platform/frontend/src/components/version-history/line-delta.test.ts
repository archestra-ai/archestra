// @vitest-environment node
import { describe, expect, it } from "vitest";
import { lineDelta } from "./line-delta";

describe("lineDelta", () => {
  it("counts an edited line as one deletion and one insertion", () => {
    expect(lineDelta("a\nb\nc", "a\nB\nc")).toEqual({ added: 1, removed: 1 });
  });

  it("matches repeated lines one for one", () => {
    // Two copies before and one after is one deletion, not zero: a set
    // comparison would see "x" on both sides and report nothing.
    expect(lineDelta("x\nx\ny", "x\ny")).toEqual({ added: 0, removed: 1 });
  });

  it("counts every line of a text that appears or disappears", () => {
    expect(lineDelta(null, "a\nb")).toEqual({ added: 2, removed: 0 });
    expect(lineDelta("a\nb", null)).toEqual({ added: 0, removed: 2 });
  });

  it("treats unset and empty as holding no lines", () => {
    expect(lineDelta(null, "")).toEqual({ added: 0, removed: 0 });
  });
});
