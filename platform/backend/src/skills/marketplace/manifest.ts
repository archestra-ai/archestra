import { createHash } from "node:crypto";
import { urlSlugify } from "@shared";

/**
 * Pure builders for the on-disk manifests served by the shared skill
 * marketplace endpoint. The same source skills produce two parallel
 * marketplace manifests — Claude Code reads `.claude-plugin/marketplace.json`,
 * Codex CLI reads `.agents/plugins/marketplace.json` — plus per-plugin
 * manifests under each skill's `plugins/<slug>/` directory.
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
  /**
   * Set when the skill row carries an explicit version. The schema doesn't
   * have a `version` column today; the parameter is kept so the day it lands
   * we don't have to revisit every builder.
   */
  version?: string | null;
  updatedAt: Date;
}

/** A skill paired with its disambiguated slug and resolved version. */
export interface ResolvedMarketplaceSkill {
  id: string;
  name: string;
  description: string;
  slug: string;
  version: string;
  updatedAt: Date;
}

export interface ClaudeMarketplacePluginEntry {
  name: string;
  source: string;
  description: string;
  version: string;
}

export interface ClaudeMarketplaceManifest {
  name: string;
  owner: { name: string };
  plugins: ClaudeMarketplacePluginEntry[];
}

export interface CodexMarketplacePluginEntry {
  name: string;
  source: { source: "local"; path: string };
  policy: { installation: "AVAILABLE"; authentication: "ON_INSTALL" };
  category: "Skill";
  version: string;
  description: string;
}

export interface CodexMarketplaceManifest {
  name: string;
  displayName: string;
  plugins: CodexMarketplacePluginEntry[];
}

export interface ClaudePluginManifest {
  name: string;
  description: string;
  version: string;
}

export interface CodexPluginManifest {
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
 * Pick the version string both manifests should report for a skill. Codex
 * requires a non-empty `version`; when the row has none, synthesize a
 * deterministic `0.0.0+<sha256(id+updatedAt)[0:12]>` so two replicas
 * agree on the same value.
 */
export function resolveSkillVersion(skill: {
  id: string;
  updatedAt: Date;
  version?: string | null;
}): string {
  const explicit = skill.version?.trim();
  if (explicit) return explicit;
  const hash = createHash("sha256")
    .update(`${skill.id}:${skill.updatedAt.toISOString()}`)
    .digest("hex")
    .slice(0, 12);
  return `0.0.0+${hash}`;
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
      version: resolveSkillVersion(skill),
      updatedAt: skill.updatedAt,
    };
  });
}

export function buildClaudeMarketplaceManifest(params: {
  marketplaceName: string;
  ownerName: string;
  skills: MarketplaceSkillInput[];
}): ClaudeMarketplaceManifest {
  const resolved = resolveMarketplaceSkills(params.skills);
  return {
    name: params.marketplaceName,
    owner: { name: params.ownerName },
    plugins: resolved.map((skill) => ({
      name: skill.slug,
      source: `./plugins/${skill.slug}`,
      description: skill.description,
      version: skill.version,
    })),
  };
}

export function buildCodexMarketplaceManifest(params: {
  marketplaceName: string;
  displayName: string;
  skills: MarketplaceSkillInput[];
}): CodexMarketplaceManifest {
  const resolved = resolveMarketplaceSkills(params.skills);
  return {
    name: params.marketplaceName,
    displayName: params.displayName,
    plugins: resolved.map((skill) => ({
      name: skill.slug,
      source: { source: "local", path: `./plugins/${skill.slug}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Skill",
      version: skill.version,
      description: skill.description,
    })),
  };
}

export function buildClaudePluginManifest(params: {
  skill: MarketplaceSkillInput;
  slug: string;
}): ClaudePluginManifest {
  return {
    name: params.slug,
    description: params.skill.description,
    version: resolveSkillVersion(params.skill),
  };
}

export function buildCodexPluginManifest(params: {
  skill: MarketplaceSkillInput;
  slug: string;
}): CodexPluginManifest {
  return {
    name: params.slug,
    version: resolveSkillVersion(params.skill),
    description: params.skill.description,
    skills: "./skills/",
    interface: { displayName: params.skill.name },
  };
}

// ===== Internal helpers =====

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
