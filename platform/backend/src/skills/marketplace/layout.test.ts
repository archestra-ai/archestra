import { describe, expect, test } from "vitest";
import { parseSkillManifest } from "@/skills/parser";
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

function makeSkill(
  files: SkillFile[],
  overrides: Partial<MaterializeSkillInput> = {},
): MaterializeSkillInput {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    name: "PDF Helper",
    description: "Helps with PDFs",
    content: "# PDF Helper",
    license: null,
    compatibility: null,
    allowedTools: null,
    templated: false,
    metadata: {},
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    files,
    ...overrides,
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

  test("keeps files whose names merely contain dots but are not `..` segments", () => {
    const files = computeLayout({
      linkId: "aaaaaaaa-1111-2222-3333-444444444444",
      marketplaceName: "org-abcd1234-skills",
      ownerName: "Acme Corp",
      displayName: "Acme Skills",
      skills: [
        makeSkill([
          makeResourceFile("notes../file.md"),
          makeResourceFile("..foo/bar.md"),
        ]),
      ],
    });

    // a "notes.." / "..foo" folder is a legitimate segment, not a traversal
    expect(files.some((f) => /\/notes\.\.\/file\.md$/.test(f.path))).toBe(true);
    expect(files.some((f) => /\/\.\.foo\/bar\.md$/.test(f.path))).toBe(true);
  });

  test("drops resource files that traverse out of the skill root", () => {
    const files = computeLayout({
      linkId: "aaaaaaaa-1111-2222-3333-444444444444",
      marketplaceName: "org-abcd1234-skills",
      ownerName: "Acme Corp",
      displayName: "Acme Skills",
      skills: [
        makeSkill([
          makeResourceFile("../evil.md"),
          makeResourceFile("a/../../etc.md"),
        ]),
      ],
    });

    expect(files.some((f) => /evil\.md$/.test(f.path))).toBe(false);
    expect(files.some((f) => /etc\.md$/.test(f.path))).toBe(false);
  });

  test("drops Windows-style backslash traversal segments", () => {
    const files = computeLayout({
      linkId: "aaaaaaaa-1111-2222-3333-444444444444",
      marketplaceName: "org-abcd1234-skills",
      ownerName: "Acme Corp",
      displayName: "Acme Skills",
      skills: [makeSkill([makeResourceFile("..\\evil.md")])],
    });

    // materialize.ts re-splits stored paths, so a backslash ".." segment must
    // be rejected too, not just POSIX "../".
    expect(files.some((f) => /evil\.md$/.test(f.path))).toBe(false);
  });

  test("preserves the display name in metadata, letting an author-provided displayName win", () => {
    const files = computeLayout({
      linkId: "aaaaaaaa-1111-2222-3333-444444444444",
      marketplaceName: "org-abcd1234-skills",
      ownerName: "Acme Corp",
      displayName: "Acme Skills",
      skills: [
        makeSkill([], { id: "a1", name: "PDF Helper" }),
        makeSkill([], {
          id: "a2",
          name: "Build App",
          metadata: { displayName: "Custom Label" },
        }),
      ],
    });

    const byDir = new Map(
      files
        .filter((f) => f.path.endsWith("/SKILL.md"))
        .map((f) => [f.path.split("/").at(-2), parseSkillManifest(f.content)]),
    );
    expect(byDir.get("pdf-helper")?.metadata.displayName).toBe("PDF Helper");
    expect(byDir.get("build-app")?.metadata.displayName).toBe("Custom Label");
  });

  test("every SKILL.md frontmatter name equals its directory, matches the Agent Skills spec, and is unique", () => {
    const files = computeLayout({
      linkId: "aaaaaaaa-1111-2222-3333-444444444444",
      marketplaceName: "org-abcd1234-skills",
      ownerName: "Acme Corp",
      displayName: "Acme Skills",
      skills: [
        makeSkill([], { id: "a1", name: "Archestra Platform Operations" }),
        makeSkill([], { id: "a2", name: "Build App" }),
        makeSkill([], { id: "a3", name: "PDF Helper" }),
        // collides with the previous slug → disambiguated with -2
        makeSkill([], { id: "a4", name: "PDF HELPER" }),
        // slugifies to empty → id-derived fallback
        makeSkill([], {
          id: "eeeeeeee-1111-2222-3333-444444444444",
          name: "🎉🎉",
        }),
        // longer than the spec's 64-char cap
        makeSkill([], { id: "a5", name: "x".repeat(80) }),
      ],
    });

    const skillMds = files.filter((f) =>
      /^plugins\/[^/]+\/skills\/[^/]+\/SKILL\.md$/.test(f.path),
    );
    expect(skillMds).toHaveLength(6);

    const seen = new Set<string>();
    for (const file of skillMds) {
      const dir = file.path.split("/").at(-2);
      const parsed = parseSkillManifest(file.content);
      expect(parsed.name).toBe(dir);
      expect(parsed.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(parsed.name.length).toBeLessThanOrEqual(64);
      seen.add(parsed.name);
    }
    expect(seen.size).toBe(skillMds.length);
  });
});
