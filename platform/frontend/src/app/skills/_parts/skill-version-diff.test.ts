import { describe, expect, it } from "vitest";
import {
  compareSkillVersionFiles,
  groupFilesByFolder,
} from "./skill-version-diff";

const file = (path: string, content: string) => ({ path, content });

describe("compareSkillVersionFiles", () => {
  it("classifies each path as added, removed, changed, or unchanged", () => {
    const compared = compareSkillVersionFiles(
      [
        file("scripts/extract.py", "print('v2')"),
        file("scripts/split.py", "new"),
        file("reference/tables.md", "same"),
      ],
      [
        file("scripts/extract.py", "print('v1')"),
        file("reference/tables.md", "same"),
        file("scripts/ocr.py", "gone"),
      ],
    );

    expect(
      Object.fromEntries(compared.map((entry) => [entry.path, entry.change])),
    ).toEqual({
      "reference/tables.md": "unchanged",
      "scripts/extract.py": "changed",
      "scripts/ocr.py": "removed",
      "scripts/split.py": "added",
    });
  });

  it("carries both sides so a changed file can be diffed", () => {
    const [entry] = compareSkillVersionFiles(
      [file("a.md", "after")],
      [file("a.md", "before")],
    );

    expect(entry.previous?.content).toBe("before");
    expect(entry.current?.content).toBe("after");
  });

  it("leaves the missing side null for added and removed files", () => {
    const compared = compareSkillVersionFiles(
      [file("added.md", "new")],
      [file("removed.md", "old")],
    );

    const added = compared.find((entry) => entry.path === "added.md");
    const removed = compared.find((entry) => entry.path === "removed.md");
    expect(added?.previous).toBeNull();
    expect(removed?.current).toBeNull();
  });

  it("sorts by path so the change list does not reshuffle between selections", () => {
    const compared = compareSkillVersionFiles(
      [file("z.md", "z"), file("a.md", "a"), file("m.md", "m")],
      [],
    );

    expect(compared.map((entry) => entry.path)).toEqual([
      "a.md",
      "m.md",
      "z.md",
    ]);
  });

  it("reports every path as unchanged when the two versions hold identical files", () => {
    const compared = compareSkillVersionFiles(
      [file("a.md", "same"), file("b.md", "same")],
      [file("b.md", "same"), file("a.md", "same")],
    );

    expect(compared.every((entry) => entry.change === "unchanged")).toBe(true);
  });
});

describe("groupFilesByFolder", () => {
  it("puts sorted folders first and loose files last", () => {
    const groups = groupFilesByFolder([
      { path: "README.md" },
      { path: "scripts/extract.py" },
      { path: "assets/logo.png" },
      { path: "scripts/split.py" },
    ]);

    expect(
      groups.map((group) => [group.folder, group.files.map((f) => f.path)]),
    ).toEqual([
      ["assets", ["assets/logo.png"]],
      ["scripts", ["scripts/extract.py", "scripts/split.py"]],
      [null, ["README.md"]],
    ]);
  });

  it("omits the root group when every file lives in a folder", () => {
    const groups = groupFilesByFolder([{ path: "scripts/only.py" }]);

    expect(groups.map((group) => group.folder)).toEqual(["scripts"]);
  });

  it("keeps nested paths in their top-level folder, the only level a skill has", () => {
    const groups = groupFilesByFolder([{ path: "references/deep/nested.md" }]);

    expect(groups).toEqual([
      { folder: "references", files: [{ path: "references/deep/nested.md" }] },
    ]);
  });
});
