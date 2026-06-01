import { describe, expect, test } from "vitest";
import type { SkillFile } from "@/types";
import { computeLayout, type MaterializeSkillInput } from "./layout";

function makeResourceFile(path: string): SkillFile {
  return {
    id: `file-${path}`,
    skillId: "11111111-2222-3333-4444-555555555555",
    path,
    content: `contents of ${path}`,
    encoding: "utf8",
    kind: "reference",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function makeSkill(files: SkillFile[]): MaterializeSkillInput {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    name: "PDF Helper",
    description: "Helps with PDFs",
    content: "# PDF Helper",
    license: null,
    compatibility: null,
    metadata: {},
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    files,
  };
}

describe("computeLayout", () => {
  test("drops resource files whose path collides only by case", () => {
    const files = computeLayout({
      linkId: "aaaaaaaa-1111-2222-3333-444444444444",
      marketplaceName: "org-abcd1234-skills",
      ownerName: "Acme Corp",
      displayName: "Acme Skills",
      skills: [
        makeSkill([
          makeResourceFile("docs/Note.md"),
          makeResourceFile("docs/note.md"),
        ]),
      ],
    });

    // exactly one survives so the on-disk tree is unambiguous across
    // case-sensitive and case-insensitive filesystems
    const docPaths = files
      .map((f) => f.path)
      .filter((p) => /\/docs\/note\.md$/i.test(p));
    expect(docPaths).toHaveLength(1);

    // no two files in the tree share a case-insensitive path
    const lowered = files.map((f) => f.path.toLowerCase());
    expect(new Set(lowered).size).toBe(lowered.length);
  });
});
