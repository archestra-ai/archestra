import { describe, expect, test } from "vitest";
import {
  buildCodexMarketplaceManifest,
  buildCodexPluginManifest,
  buildCodexPluginMarketplaceEntry,
  buildCodexPluginPayloadManifest,
  buildPluginMarketplaceEntry,
  buildPluginPayloadManifest,
  buildSimpleMarketplaceManifest,
  buildSimplePluginManifest,
  isReservedMarketplaceName,
  type MarketplaceSkillInput,
  RESERVED_MARKETPLACE_NAMES,
  resolveMarketplaceSkills,
  resolvePluginName,
  resolvePluginVersion,
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

describe("resolvePluginVersion", () => {
  test("emits a real monotonic SemVer from the revision sequence", () => {
    expect(resolvePluginVersion(0)).toBe("0.0.0");
    expect(resolvePluginVersion(1)).toBe("0.1.0");
    expect(resolvePluginVersion(2)).toBe("0.2.0");
  });

  test("rejects invalid revision sequences", () => {
    expect(() => resolvePluginVersion(-1)).toThrow(
      "revisionSequence must be a non-negative safe integer",
    );
    expect(() => resolvePluginVersion(1.5)).toThrow(
      "revisionSequence must be a non-negative safe integer",
    );
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

  test("caps slugs at 64 characters and trims a trailing hyphen at the cut", () => {
    const [long] = resolveMarketplaceSkills([
      makeSkill({ name: "x".repeat(80) }),
    ]);
    expect(long.slug).toBe("x".repeat(64));

    // the cut lands on the separator hyphen, which must not survive
    const [cutOnHyphen] = resolveMarketplaceSkills([
      makeSkill({ name: `${"a".repeat(63)} b` }),
    ]);
    expect(cutOnHyphen.slug).toBe("a".repeat(63));
  });

  test("collision suffixes stay within the 64-char cap", () => {
    const resolved = resolveMarketplaceSkills([
      makeSkill({ id: "a", name: "x".repeat(70) }),
      makeSkill({ id: "b", name: "x".repeat(70) }),
    ]);
    expect(resolved.map((s) => s.slug)).toEqual([
      "x".repeat(64),
      `${"x".repeat(62)}-2`,
    ]);
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
  test("emits a single skills plugin pointing at plugins/<marketplaceName>", () => {
    const manifest = buildSimpleMarketplaceManifest({
      marketplaceName: "archestra-acme-skills",
      ownerName: "Acme Corp",
      skills: [
        makeSkill({ id: "a", name: "PDF Helper" }),
        makeSkill({ id: "b", name: "CSV Tools" }),
      ],
      version: "0.7.0",
    });
    expect(manifest).toEqual({
      name: "archestra-acme-skills",
      owner: { name: "Acme Corp" },
      plugins: [
        {
          name: "archestra-acme-skills",
          source: "./plugins/archestra-acme-skills",
          description: "2 skills shared from Acme Corp",
          version: "0.7.0",
        },
      ],
    });
  });

  test("uses singular 'skill' when exactly one is shared", () => {
    const manifest = buildSimpleMarketplaceManifest({
      marketplaceName: "m",
      ownerName: "Owner",
      skills: [makeSkill()],
      version: "0.1.0",
    });
    expect(manifest.plugins[0].description).toBe("1 skill shared from Owner");
  });
});

describe("buildCodexMarketplaceManifest", () => {
  test("emits a single Codex skills plugin with policy and category", () => {
    const manifest = buildCodexMarketplaceManifest({
      marketplaceName: "archestra-acme-skills",
      displayName: "Acme Skills",
      skills: [makeSkill({ name: "PDF Helper" })],
      version: "0.4.0",
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
          version: "0.4.0",
          description: "1 skill shared from Acme Skills",
        },
      ],
    });
  });
});

describe("buildSimplePluginManifest (Claude Code + Cursor)", () => {
  test("returns the plugin's name/description/version", () => {
    const skills = [
      makeSkill({ id: "a", name: "Alpha" }),
      makeSkill({ id: "b", name: "Beta" }),
    ];
    expect(
      buildSimplePluginManifest({
        marketplaceName: "archestra-acme-skills",
        ownerName: "Acme Corp",
        skills,
        version: "0.2.0",
      }),
    ).toEqual({
      name: "archestra-acme-skills",
      description: "2 skills shared from Acme Corp",
      version: "0.2.0",
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
        version: "0.3.0",
      }),
    ).toEqual({
      name: "archestra-acme-skills",
      version: "0.3.0",
      description: "1 skill shared from Acme Skills",
      skills: "./skills/",
      interface: { displayName: "Acme Skills" },
    });
  });
});

describe("plugin manifests", () => {
  test("authors metadata only and never models hook semantics", () => {
    const simpleEntry = buildPluginMarketplaceEntry({
      pluginName: "plugin-session-attribution-12345678",
      description: "Attributes sessions",
      version: "0.8.0",
    });
    const simplePlugin = buildPluginPayloadManifest({
      pluginName: simpleEntry.name,
      description: simpleEntry.description,
      version: simpleEntry.version,
    });
    const codexEntry = buildCodexPluginMarketplaceEntry({
      pluginName: simpleEntry.name,
      description: simpleEntry.description,
      version: simpleEntry.version,
    });
    const codexPlugin = buildCodexPluginPayloadManifest({
      pluginName: simpleEntry.name,
      displayName: "Session attribution",
      description: simpleEntry.description,
      version: simpleEntry.version,
    });

    expect(simpleEntry.source).toBe(
      "./plugins/plugin-session-attribution-12345678",
    );
    expect(codexEntry.category).toBe("Hooks");
    expect(codexEntry.source).toEqual({
      source: "local",
      path: "./plugins/plugin-session-attribution-12345678",
    });
    expect(simplePlugin).not.toHaveProperty("hooks");
    expect(codexPlugin).not.toHaveProperty("hooks");
    expect(codexPlugin).not.toHaveProperty("skills");
  });

  test("keeps plugin identity under the shared 64-character cap", () => {
    expect(resolvePluginName("x".repeat(48))).toHaveLength(48);
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
