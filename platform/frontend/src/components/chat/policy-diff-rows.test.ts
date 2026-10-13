// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getPolicyDiffRows } from "./policy-diff-rows";

describe("getPolicyDiffRows", () => {
  it("shows a first policy with every line added", () => {
    expect(
      getPolicyDiffRows({ before: "", after: "a\nb\n", diff: "ignored" }),
    ).toEqual([
      { kind: "add", line: 1, text: "a" },
      { kind: "add", line: 2, text: "b" },
    ]);
  });

  it("numbers hunk lines by the new file and folds what the diff left out", () => {
    expect(
      getPolicyDiffRows({
        before: "a\nb\nc\nd\ne\nf\ng\nh\ni\n",
        after: "a\nb\nc\nd\ne\nX\ng\nh\ni\n",
        diff: "--- a/p\n+++ b/p\n@@ -5,3 +5,3 @@\n e\n-f\n+X\n g\n",
      }),
    ).toEqual([
      { kind: "gap" },
      { kind: "context", line: 5, text: "e" },
      { kind: "remove", line: null, text: "f" },
      { kind: "add", line: 6, text: "X" },
      { kind: "context", line: 7, text: "g" },
      { kind: "gap" },
    ]);
  });
});
