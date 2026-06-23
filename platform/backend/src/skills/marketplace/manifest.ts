import { createHash } from "node:crypto";
import { urlSlugify } from "@archestra/shared";

/**
 * Pure builders for the on-disk manifests served by the shared skill
 * marketplace endpoint. The same materialized repo serves three clients in
 * parallel:
 *
 *   - Claude Code: `.claude-plugin/marketplace.json`
 *   - Codex CLI:   `.agents/plugins/marketplace.json`
 *   - Cursor:      `.cursor-plugin/marketplace.json`
 *
 * Each one sees a marketplace with exactly one plugin that bundles every
 * shared skill under a single `skills/<slug>/` directory inside the plugin.
 *
 * The output here is consumed by `materialize.ts`; this module has no I/O.
 *
 * @see https://agentskills.io/specification
 */

/** Input shape accepted by every builder in this module. */
export interface MarketplaceSkillInput {
  id: string;
  name: string;
  description: string;
  updatedAt: Date;
}

/** A skill paired with its disambiguated slug (used as its `skills/<slug>/` directory). */
interface ResolvedMarketplaceSkill {
  id: string;
  name: string;
  description: string;
  slug: string;
  updatedAt: Date;
}

/**
 * Marketplace + plugin shape shared by Claude Code and Cursor. Cursor's docs
 * describe `.cursor-plugin/marketplace.json` / `.cursor-plugin/plugin.json`
 * with a field set that is intentionally a strict subset of Claude's, so both
 * clients see the same name/description/version triple from one builder.
 */
interface SimpleMarketplacePluginEntry {
  name: string;
  source: string;
  description: string;
  version: string;
}

interface SimpleMarketplaceManifest {
  name: string;
  owner: { name: string };
  plugins: SimpleMarketplacePluginEntry[];
}

interface CodexMarketplacePluginEntry {
  name: string;
  source: { source: "local"; path: string };
  policy: { installation: "AVAILABLE"; authentication: "ON_INSTALL" };
  category: "Skill";
  version: string;
  description: string;
}

interface CodexMarketplaceManifest {
  name: string;
  displayName: string;
  plugins: CodexMarketplacePluginEntry[];
}

interface SimplePluginManifest {
  name: string;
  description: string;
  version: string;
}

interface CodexPluginManifest {
  name: string;
  version: string;
  description: string;
  skills: string;
  interface: { displayName: string };
}

/**
 * Marketplace names baked into Claude Code's CLI. Reused at share-link create
 * time so users never end up with a marketplace that silently shadows one of
 * Claude's built-ins. List captured from the Claude docs survey; revisit when
 * the docs add new ones.
 * @public — exported for testability
 */
export const RESERVED_MARKETPLACE_NAMES: ReadonlySet<string> = new Set([
  "claude-code-marketplace",
  "claude-code-plugins",
  "claude-plugins-official",
  "anthropic-marketplace",
]);

export function isReservedMarketplaceName(name: string): boolean {
  return RESERVED_MARKETPLACE_NAMES.has(name.trim().toLowerCase());
}

/**
 * Resolve every skill in the input list to a unique `^[a-z0-9-]+$` slug,
 * disambiguating collisions deterministically by appending `-2`, `-3`, etc.
 * Order is preserved so manifest output is stable across runs.
 */
export function resolveMarketplaceSkills(
  skills: MarketplaceSkillInput[],
): ResolvedMarketplaceSkill[] {
  const used = new Set<string>();
  return skills.map((skill) => {
    const base = baseSlug(skill);
    let slug = base;
    let counter = 2;
    while (used.has(slug)) {
      slug = `${base}-${counter}`;
      counter += 1;
    }
    used.add(slug);
    return {
      id: skill.id,
      name: skill.name,
      description: skill.description,
      slug,
      updatedAt: skill.updatedAt,
    };
  });
}

/**
 * Version for the single bundle plugin. Derived from the sorted set of skill
 * (id, updatedAt) pairs so two replicas materializing the same input agree on
 * the same value, and editing any skill bumps the version exactly once.
 * @public — exported for testability
 */
export function resolveBundleVersion(skills: MarketplaceSkillInput[]): string {
  if (skills.length === 0) return "0.0.0+empty";
  const sorted = [...skills].sort((a, b) => a.id.localeCompare(b.id));
  const h = createHash("sha256");
  for (const s of sorted) {
    h.update(s.id);
    h.update("\0");
    h.update(s.updatedAt.toISOString());
    h.update("\0");
  }
  return `0.0.0+${h.digest("hex").slice(0, 12)}`;
}

export function buildSimpleMarketplaceManifest(
  params: SimpleManifestParams,
): SimpleMarketplaceManifest {
  return {
    name: params.marketplaceName,
    owner: { name: params.ownerName },
    plugins: [
      {
        name: params.marketplaceName,
        source: `./plugins/${params.marketplaceName}`,
        description: bundleDescription(params.skills.length, params.ownerName),
        version: resolveBundleVersion(params.skills),
      },
    ],
  };
}

export function buildSimplePluginManifest(
  params: SimpleManifestParams,
): SimplePluginManifest {
  return {
    name: params.marketplaceName,
    description: bundleDescription(params.skills.length, params.ownerName),
    version: resolveBundleVersion(params.skills),
  };
}

export function buildCodexMarketplaceManifest(params: {
  marketplaceName: string;
  displayName: string;
  skills: MarketplaceSkillInput[];
}): CodexMarketplaceManifest {
  return {
    name: params.marketplaceName,
    displayName: params.displayName,
    plugins: [
      {
        name: params.marketplaceName,
        source: {
          source: "local",
          path: `./plugins/${params.marketplaceName}`,
        },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Skill",
        version: resolveBundleVersion(params.skills),
        description: bundleDescription(
          params.skills.length,
          params.displayName,
        ),
      },
    ],
  };
}

export function buildCodexPluginManifest(params: {
  marketplaceName: string;
  displayName: string;
  skills: MarketplaceSkillInput[];
}): CodexPluginManifest {
  return {
    name: params.marketplaceName,
    version: resolveBundleVersion(params.skills),
    description: bundleDescription(params.skills.length, params.displayName),
    skills: "./skills/",
    interface: { displayName: params.displayName },
  };
}

// ===== Internal helpers =====

interface SimpleManifestParams {
  marketplaceName: string;
  ownerName: string;
  skills: MarketplaceSkillInput[];
}

function baseSlug(skill: MarketplaceSkillInput): string {
  const slugged = urlSlugify(skill.name);
  if (slugged) return slugged;
  // Names that slugify to empty (e.g. all punctuation or non-ASCII) still
  // need a stable slug; fall back to a prefix of the skill id.
  return `skill-${skill.id
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 8)
    .toLowerCase()}`;
}

function bundleDescription(skillCount: number, sourceLabel: string): string {
  const noun = skillCount === 1 ? "skill" : "skills";
  return `${skillCount} ${noun} shared from ${sourceLabel}`;
}
