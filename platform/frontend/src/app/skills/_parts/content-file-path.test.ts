import { describe, expect, it } from "vitest";
import { contentFilePathProblem } from "./content-file-path";

const check = (path: string, existingPaths: string[] = [], manifest = false) =>
  contentFilePathProblem({
    path,
    existingPaths,
    manifestPath: manifest ? "SKILL.md" : undefined,
  });

describe("contentFilePathProblem", () => {
  it("accepts a new file at the top or inside a folder", () => {
    expect(check("notes.md")).toBeNull();
    expect(check("hooks/pre-commit.sh", ["hooks/hooks.json"])).toBeNull();
  });

  it("refuses a path that climbs out of the folder", () => {
    expect(check("../evil.txt")).toMatch(/\.\./);
    expect(check("a/../b.md")).toMatch(/\.\./);
    expect(check("./b.md")).toMatch(/\.\./);
  });

  it("refuses empty folder names and a leading or trailing slash", () => {
    for (const path of ["a//b.md", "/abs.md", "trailing/"]) {
      expect(check(path)).toBe("Remove the extra / from the path.");
    }
  });

  it("refuses a backslash", () => {
    expect(check("a\\b.md")).toMatch(/backslash/);
  });

  it("refuses a name that is already taken, ignoring letter case", () => {
    expect(check("hooks/hooks.json", ["hooks/hooks.json"])).toBe(
      "A file with this name already exists.",
    );
    expect(check("Hooks/HOOKS.json", ["hooks/hooks.json"])).toBe(
      "A file with this name already exists.",
    );
  });

  it("refuses a second manifest only where the editor has one", () => {
    expect(check("SKILL.md", [], true)).toBe(
      "SKILL.md is already in the list.",
    );
    expect(check("skill.md", [], true)).toBe(
      "SKILL.md is already in the list.",
    );
    expect(check("references/SKILL.md", [], true)).toBeNull();
    expect(check("SKILL.md", [], false)).toBeNull();
  });

  it("refuses a file and a folder under one name", () => {
    expect(check("docs", ["docs/a.md"])).toBe(
      "A folder with this name already exists.",
    );
    expect(check("readme/part.md", ["readme"])).toBe(
      "readme is a file, so it cannot hold other files.",
    );
  });

  it("refuses a path longer than the server stores", () => {
    expect(check(`${"a".repeat(513)}`)).toMatch(/at most 512/);
  });
});
