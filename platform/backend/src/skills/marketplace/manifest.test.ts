import { describe, expect, test } from "vitest";
import {
  buildCodexMarketplaceManifest,
  buildCodexPluginManifest,
  buildSimpleMarketplaceManifest,
  buildSimplePluginManifest,
  isReservedMarketplaceName,
  type MarketplaceSkillInput,
  RESERVED_MARKETPLACE_NAMES,
  resolveBundleVersion,
  resolveMarketplaceSkills,
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

describe("resolveBundleVersion", () => {
  test("emits 0.0.0+<12 hex> for a non-empty input", () => {
    expect(resolveBundleVersion([makeSkill()])).toMatch(
      /^0\.0\.0\+[a-f0-9]{12}$/,
    );
  });

  test("is deterministic across calls with the same input", () => {
    const skills = [
      makeSkill({ id: "a", name: "Alpha" }),
      makeSkill({ id: "b", name: "Beta" }),
    ];
    expect(resolveBundleVersion(skills)).toBe(resolveBundleVersion(skills));
  });

  test("is independent of input order (sorted internally)", () => {
    const ordered = [
      makeSkill({ id: "a", name: "Alpha" }),
      makeSkill({ id: "b", name: "Beta" }),
    ];
    const reversed = [...ordered].reverse();
    expect(resolveBundleVersion(ordered)).toBe(resolveBundleVersion(reversed));
  });

  test("changes when any skill's updatedAt changes", () => {
    const a = resolveBundleVersion([makeSkill()]);
    const b = resolveBundleVersion([
      makeSkill({ updatedAt: new Date("2026-06-01T00:00:00.000Z") }),
    ]);
    expect(a).not.toBe(b);
  });

  test("changes when the set of skill ids changes", () => {
    const a = resolveBundleVersion([makeSkill({ id: "x" })]);
    const b = resolveBundleVersion([makeSkill({ id: "y" })]);
    expect(a).not.toBe(b);
  });

  test("empty input returns a stable sentinel", () => {
    expect(resolveBundleVersion([])).toBe("0.0.0+empty");
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
});

describe("buildSimpleMarketplaceManifest (Claude Code + Cursor)", () => {
  test("emits a single bundle plugin pointing at plugins/<marketplaceName>", () => {
    const manifest = buildSimpleMarketplaceManifest({
      marketplaceName: "archestra-acme-skills",
      ownerName: "Acme Corp",
      skills: [
        makeSkill({ id: "a", name: "PDF Helper" }),
        makeSkill({ id: "b", name: "CSV Tools" }),
      ],
    });
    expect(manifest).toEqual({
      name: "archestra-acme-skills",
      owner: { name: "Acme Corp" },
      plugins: [
        {
          name: "archestra-acme-skills",
          source: "./plugins/archestra-acme-skills",
          description: "2 skills shared from Acme Corp",
          version: expect.stringMatching(/^0\.0\.0\+[a-f0-9]{12}$/),
        },
      ],
    });
  });

  test("uses singular 'skill' when exactly one is shared", () => {
    const manifest = buildSimpleMarketplaceManifest({
      marketplaceName: "m",
      ownerName: "Owner",
      skills: [makeSkill()],
    });
    expect(manifest.plugins[0].description).toBe("1 skill shared from Owner");
  });
});

describe("buildCodexMarketplaceManifest", () => {
  test("emits a single bundle plugin with Codex policy + category", () => {
    const manifest = buildCodexMarketplaceManifest({
      marketplaceName: "archestra-acme-skills",
      displayName: "Acme Skills",
      skills: [makeSkill({ name: "PDF Helper" })],
    });
    expect(manifest).toEqual({
      name: "archestra-acme-skills",
      displayName: "Acme Skills",
      plugins: [
        {
          name: "archestra-acme-skills",
          source: {
            source: "local",
            path: "./plugins/archestra-acme-skills",
          },
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
          },
          category: "Skill",
          version: expect.stringMatching(/^0\.0\.0\+[a-f0-9]{12}$/),
          description: "1 skill shared from Acme Skills",
        },
      ],
    });
  });
});

describe("buildSimplePluginManifest (Claude Code + Cursor)", () => {
  test("returns the bundle's name/description/version", () => {
    const skills = [
      makeSkill({ id: "a", name: "Alpha" }),
      makeSkill({ id: "b", name: "Beta" }),
    ];
    expect(
      buildSimplePluginManifest({
        marketplaceName: "archestra-acme-skills",
        ownerName: "Acme Corp",
        skills,
      }),
    ).toEqual({
      name: "archestra-acme-skills",
      description: "2 skills shared from Acme Corp",
      version: resolveBundleVersion(skills),
    });
  });
});

describe("buildCodexPluginManifest", () => {
  test("points at ./skills/ and stamps the display name on the interface", () => {
    const skills = [makeSkill()];
    expect(
      buildCodexPluginManifest({
        marketplaceName: "archestra-acme-skills",
        displayName: "Acme Skills",
        skills,
      }),
    ).toEqual({
      name: "archestra-acme-skills",
      version: resolveBundleVersion(skills),
      description: "1 skill shared from Acme Skills",
      skills: "./skills/",
      interface: { displayName: "Acme Skills" },
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
    expect(isReservedMarketplaceName("archestra-acme-skills")).toBe(false);
  });
});
