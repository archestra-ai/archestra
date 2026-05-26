import { describe, expect, test } from "vitest";
import {
  buildClaudeMarketplaceManifest,
  buildClaudePluginManifest,
  buildCodexMarketplaceManifest,
  buildCodexPluginManifest,
  isReservedMarketplaceName,
  type MarketplaceSkillInput,
  RESERVED_MARKETPLACE_NAMES,
  resolveMarketplaceSkills,
  resolveSkillVersion,
} from "./manifest";

function makeSkill(
  overrides: Partial<MarketplaceSkillInput> = {},
): MarketplaceSkillInput {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    name: "PDF Helper",
    description: "Helps with PDFs",
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("resolveSkillVersion", () => {
  test("uses skill.version verbatim when set", () => {
    expect(resolveSkillVersion(makeSkill({ version: "1.2.3" }))).toBe("1.2.3");
  });

  test("treats blank/undefined version as missing and synthesizes a hash", () => {
    const synthesized = resolveSkillVersion(makeSkill());
    expect(synthesized).toMatch(/^0\.0\.0\+[a-f0-9]{12}$/);
    expect(resolveSkillVersion(makeSkill({ version: "" }))).toBe(synthesized);
    expect(resolveSkillVersion(makeSkill({ version: "   " }))).toBe(
      synthesized,
    );
    expect(resolveSkillVersion(makeSkill({ version: null }))).toBe(synthesized);
  });

  test("synthesized version is deterministic across calls", () => {
    const skill = makeSkill();
    expect(resolveSkillVersion(skill)).toBe(resolveSkillVersion(skill));
  });

  test("synthesized version changes when updatedAt changes", () => {
    const a = resolveSkillVersion(makeSkill());
    const b = resolveSkillVersion(
      makeSkill({ updatedAt: new Date("2026-06-01T00:00:00.000Z") }),
    );
    expect(a).not.toBe(b);
  });

  test("synthesized version changes when id changes", () => {
    const a = resolveSkillVersion(makeSkill({ id: "a" }));
    const b = resolveSkillVersion(makeSkill({ id: "b" }));
    expect(a).not.toBe(b);
  });
});

describe("resolveMarketplaceSkills", () => {
  test("derives URL-friendly slugs from skill names", () => {
    const [skill] = resolveMarketplaceSkills([
      makeSkill({ name: "PDF Helper" }),
    ]);
    expect(skill.slug).toBe("pdf-helper");
  });

  test("disambiguates colliding slugs in input order", () => {
    const skills = [
      makeSkill({ id: "a", name: "PDF Helper" }),
      makeSkill({ id: "b", name: "PDF HELPER" }),
      makeSkill({ id: "c", name: "pdf-helper" }),
    ];
    const resolved = resolveMarketplaceSkills(skills);
    expect(resolved.map((s) => s.slug)).toEqual([
      "pdf-helper",
      "pdf-helper-2",
      "pdf-helper-3",
    ]);
  });

  test("falls back to an id-derived slug when the name slugifies to empty", () => {
    const [skill] = resolveMarketplaceSkills([
      makeSkill({ id: "abcdef1234567890", name: "!!!" }),
    ]);
    expect(skill.slug).toMatch(/^skill-[a-z0-9]+$/);
    expect(skill.slug).toBe("skill-abcdef12");
  });

  test("preserves input order", () => {
    const skills = [
      makeSkill({ id: "b", name: "Beta" }),
      makeSkill({ id: "a", name: "Alpha" }),
    ];
    expect(resolveMarketplaceSkills(skills).map((s) => s.id)).toEqual([
      "b",
      "a",
    ]);
  });

  test("attaches the resolved version on each entry", () => {
    const [resolved] = resolveMarketplaceSkills([
      makeSkill({ version: "9.9.9" }),
    ]);
    expect(resolved.version).toBe("9.9.9");
  });
});

describe("buildClaudeMarketplaceManifest", () => {
  test("snapshots the single-skill shape", () => {
    const manifest = buildClaudeMarketplaceManifest({
      marketplaceName: "org-abcd1234-skills",
      ownerName: "Acme Corp",
      skills: [makeSkill({ name: "PDF Helper" })],
    });
    expect(manifest).toEqual({
      name: "org-abcd1234-skills",
      owner: { name: "Acme Corp" },
      plugins: [
        {
          name: "pdf-helper",
          source: "./plugins/pdf-helper",
          description: "Helps with PDFs",
          version: expect.stringMatching(/^0\.0\.0\+[a-f0-9]{12}$/),
        },
      ],
    });
  });

  test("emits one entry per skill in input order with disambiguated slugs", () => {
    const manifest = buildClaudeMarketplaceManifest({
      marketplaceName: "m",
      ownerName: "Owner",
      skills: [
        makeSkill({ id: "1", name: "Alpha" }),
        makeSkill({ id: "2", name: "Beta" }),
        makeSkill({ id: "3", name: "ALPHA" }),
      ],
    });
    expect(manifest.plugins.map((p) => p.name)).toEqual([
      "alpha",
      "beta",
      "alpha-2",
    ]);
    expect(manifest.plugins.map((p) => p.source)).toEqual([
      "./plugins/alpha",
      "./plugins/beta",
      "./plugins/alpha-2",
    ]);
  });

  test("propagates explicit skill.version", () => {
    const manifest = buildClaudeMarketplaceManifest({
      marketplaceName: "m",
      ownerName: "o",
      skills: [makeSkill({ version: "2.0.1" })],
    });
    expect(manifest.plugins[0].version).toBe("2.0.1");
  });
});

describe("buildCodexMarketplaceManifest", () => {
  test("snapshots the single-skill shape", () => {
    const manifest = buildCodexMarketplaceManifest({
      marketplaceName: "org-abcd1234-skills",
      displayName: "Acme Skills",
      skills: [makeSkill({ name: "PDF Helper" })],
    });
    expect(manifest).toEqual({
      name: "org-abcd1234-skills",
      displayName: "Acme Skills",
      plugins: [
        {
          name: "pdf-helper",
          source: { source: "local", path: "./plugins/pdf-helper" },
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
          },
          category: "Skill",
          version: expect.stringMatching(/^0\.0\.0\+[a-f0-9]{12}$/),
          description: "Helps with PDFs",
        },
      ],
    });
  });

  test("emits one entry per skill in input order with disambiguated slugs", () => {
    const manifest = buildCodexMarketplaceManifest({
      marketplaceName: "m",
      displayName: "Display",
      skills: [
        makeSkill({ id: "1", name: "Alpha" }),
        makeSkill({ id: "2", name: "ALPHA" }),
      ],
    });
    expect(manifest.plugins.map((p) => p.name)).toEqual(["alpha", "alpha-2"]);
    expect(manifest.plugins[0].source.path).toBe("./plugins/alpha");
    expect(manifest.plugins[1].source.path).toBe("./plugins/alpha-2");
  });
});

describe("buildClaudePluginManifest", () => {
  test("returns name, description, version", () => {
    const skill = makeSkill();
    expect(buildClaudePluginManifest({ skill, slug: "pdf-helper" })).toEqual({
      name: "pdf-helper",
      description: skill.description,
      version: resolveSkillVersion(skill),
    });
  });
});

describe("buildCodexPluginManifest", () => {
  test("returns the Codex per-plugin shape", () => {
    const skill = makeSkill();
    expect(buildCodexPluginManifest({ skill, slug: "pdf-helper" })).toEqual({
      name: "pdf-helper",
      version: resolveSkillVersion(skill),
      description: skill.description,
      skills: "./skills/",
      interface: { displayName: skill.name },
    });
  });
});

describe("reserved marketplace names", () => {
  test("contains the documented Claude built-ins", () => {
    expect(RESERVED_MARKETPLACE_NAMES.size).toBeGreaterThan(0);
    expect(isReservedMarketplaceName("claude-code-marketplace")).toBe(true);
    expect(isReservedMarketplaceName("anthropic-marketplace")).toBe(true);
  });

  test("is case-insensitive and ignores surrounding whitespace", () => {
    expect(isReservedMarketplaceName("Claude-Code-Marketplace")).toBe(true);
    expect(isReservedMarketplaceName("  CLAUDE-CODE-PLUGINS  ")).toBe(true);
  });

  test("allows org-scoped marketplace names", () => {
    expect(isReservedMarketplaceName("org-abcd1234-skills")).toBe(false);
  });
});
