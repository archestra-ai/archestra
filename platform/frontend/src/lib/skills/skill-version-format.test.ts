import { describe, expect, it } from "vitest";
import type { SkillVersionSummary } from "@/lib/skills/skill.query";
import { groupVersionsByDay, languageForPath } from "./skill-version-format";

const version = (n: number, createdAt: string): SkillVersionSummary => ({
  id: `version-${n}`,
  skillId: "skill-1",
  version: n,
  contentHash: `hash-${n}`,
  createdAt,
});

describe("groupVersionsByDay", () => {
  it("collapses versions made on the same day into one group", () => {
    const groups = groupVersionsByDay([
      version(3, "2026-08-03T18:00:00.000Z"),
      version(2, "2026-08-03T09:00:00.000Z"),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.versions.map((v) => v.version)).toEqual([3, 2]);
  });

  it("starts a new group when the day changes", () => {
    const groups = groupVersionsByDay([
      version(3, "2026-08-03T09:00:00.000Z"),
      version(2, "2026-08-02T09:00:00.000Z"),
      version(1, "2026-08-01T09:00:00.000Z"),
    ]);

    expect(groups.map((group) => group.versions.map((v) => v.version))).toEqual(
      [[3], [2], [1]],
    );
  });

  it("keeps the order it was given rather than sorting", () => {
    // A version out of sequence gets its own group instead of being folded
    // into the earlier group for that day, which would reorder the timeline.
    const groups = groupVersionsByDay([
      version(3, "2026-08-03T09:00:00.000Z"),
      version(2, "2026-08-02T09:00:00.000Z"),
      version(1, "2026-08-03T09:00:00.000Z"),
    ]);

    expect(groups).toHaveLength(3);
    expect(groups[0]?.label).toBe(groups[2]?.label);
  });

  it("has no groups for no versions", () => {
    expect(groupVersionsByDay([])).toEqual([]);
  });
});

describe("languageForPath", () => {
  it("reads the language off the extension", () => {
    expect(languageForPath("scripts/run.py")).toBe("python");
    expect(languageForPath("references/notes.md")).toBe("markdown");
    expect(languageForPath("config.yml")).toBe("yaml");
  });

  it("ignores extension case", () => {
    expect(languageForPath("DATA.JSON")).toBe("json");
  });

  it("falls back to plain text for anything unrecognised", () => {
    expect(languageForPath("assets/logo.psd")).toBe("plaintext");
  });

  it("treats a file with no extension as plain text", () => {
    expect(languageForPath("LICENSE")).toBe("plaintext");
  });
});
