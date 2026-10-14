import { describe, expect, it } from "vitest";
import { normalizeGitSubpath } from "./git-hosts";

describe("normalizeGitSubpath", () => {
  it("drops a leading ./ or / and trailing slashes", () => {
    expect(normalizeGitSubpath("./skills/pdf/")).toBe("skills/pdf");
    expect(normalizeGitSubpath("//skills//")).toBe("skills");
    expect(normalizeGitSubpath(".hidden/x")).toBe(".hidden/x");
    expect(normalizeGitSubpath("./")).toBe("");
    expect(normalizeGitSubpath("")).toBe("");
  });

  it("stays linear on a long run of slashes inside the path", () => {
    const path = `a${"/".repeat(100_000)}b`;
    const started = performance.now();
    expect(normalizeGitSubpath(path)).toBe(path);
    expect(performance.now() - started).toBeLessThan(100);
  });
});
