import { urlSlugify } from "@archestra/shared";
import type { ClientType } from "@/types";

/**
 * Pure builders for the on-disk manifests served by the shared skill
 * marketplace endpoint. The same materialized repo serves three clients in
 * parallel:
 *
 *   - Claude Code: `.claude-plugin/marketplace.json`
 *   - Codex CLI:   `.agents/plugins/marketplace.json`
 *   - Cursor:      `.cursor-plugin/marketplace.json`
 *
 * Each one sees a marketplace with exactly one plugin that plugins every
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
  plugins: Array<CodexMarketplacePluginEntry | CodexPluginMarketplaceEntry>;
}

interface CodexPluginMarketplaceEntry {
  name: string;
  source: { source: "local"; path: string };
  policy: { installation: "AVAILABLE"; authentication: "ON_INSTALL" };
  category: "Hooks";
  version: string;
  description: string;
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

interface CodexPluginPayloadManifest {
  name: string;
  version: string;
  description: string;
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
      const suffix = `-${counter}`;
      slug = `${truncateSlug(base, MAX_SKILL_SLUG_LENGTH - suffix.length)}${suffix}`;
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
 * Monotonic version for the single plugin plugin. The revision sequence is
 * durable and advances exactly once for each changed materialized tree, so
 * clients can compare versions using SemVer precedence instead of ignoring a
 * content hash stored as build metadata.
 * @public — exported for testability
 */
export function resolvePluginVersion(revisionSequence: number): string {
  if (!Number.isSafeInteger(revisionSequence) || revisionSequence < 0) {
    throw new Error("revisionSequence must be a non-negative safe integer");
  }
  return `0.${revisionSequence}.0`;
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
        description: pluginDescription(params.skills.length, params.ownerName),
        version: params.version,
      },
    ],
  };
}

export function buildSimplePluginManifest(
  params: SimpleManifestParams,
): SimplePluginManifest {
  return {
    name: params.marketplaceName,
    description: pluginDescription(params.skills.length, params.ownerName),
    version: params.version,
  };
}

export function buildCodexMarketplaceManifest(params: {
  marketplaceName: string;
  displayName: string;
  skills: MarketplaceSkillInput[];
  version: string;
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
        version: params.version,
        description: pluginDescription(
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
  version: string;
}): CodexPluginManifest {
  return {
    name: params.marketplaceName,
    version: params.version,
    description: pluginDescription(params.skills.length, params.displayName),
    skills: "./skills/",
    interface: { displayName: params.displayName },
  };
}

export function buildPluginMarketplaceEntry(params: {
  pluginName: string;
  description: string;
  version: string;
}): SimpleMarketplacePluginEntry {
  return {
    name: params.pluginName,
    source: `./plugins/${params.pluginName}`,
    description: params.description,
    version: params.version,
  };
}

export function buildCodexPluginMarketplaceEntry(params: {
  pluginName: string;
  description: string;
  version: string;
}): CodexPluginMarketplaceEntry {
  return {
    name: params.pluginName,
    source: { source: "local", path: `./plugins/${params.pluginName}` },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Hooks",
    version: params.version,
    description: params.description,
  };
}

export function buildPluginPayloadManifest(params: {
  pluginName: string;
  description: string;
  version: string;
}): SimplePluginManifest {
  return {
    name: params.pluginName,
    description: params.description,
    version: params.version,
  };
}

export function buildCodexPluginPayloadManifest(params: {
  pluginName: string;
  displayName: string;
  description: string;
  version: string;
}): CodexPluginPayloadManifest {
  return {
    name: params.pluginName,
    version: params.version,
    description: params.description,
    interface: { displayName: params.displayName },
  };
}

/**
 * Installed identity for one opaque plugin. It is marketplace-qualified by
 * every client, so repeating the marketplace name here only risks exceeding
 * the clients' 64-character plugin-name cap.
 */
export function resolvePluginName(pluginSlug: string): string {
  return pluginSlug;
}

export function pluginManifestPath(clientType: ClientType): string {
  switch (clientType) {
    case "claude-code":
      return ".claude-plugin/plugin.json";
    case "copilot-cli":
      return "plugin.json";
    case "codex":
      return ".codex-plugin/plugin.json";
    case "cursor":
      return ".cursor-plugin/plugin.json";
  }
}

// ===== Internal helpers =====

interface SimpleManifestParams {
  marketplaceName: string;
  ownerName: string;
  skills: MarketplaceSkillInput[];
  version: string;
}

function baseSlug(skill: MarketplaceSkillInput): string {
  const slugged = truncateSlug(urlSlugify(skill.name), MAX_SKILL_SLUG_LENGTH);
  if (slugged) return slugged;
  // Names that slugify to empty (e.g. all punctuation or non-ASCII) still
  // need a stable slug; fall back to a prefix of the skill id.
  return `skill-${skill.id
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 8)
    .toLowerCase()}`;
}

// The Agent Skills spec caps skill names (and therefore directory slugs,
// which must equal the frontmatter name) at 64 characters.
const MAX_SKILL_SLUG_LENGTH = 64;

function truncateSlug(slug: string, max: number): string {
  return slug.slice(0, max).replace(/-+$/g, "");
}

function pluginDescription(skillCount: number, sourceLabel: string): string {
  const noun = skillCount === 1 ? "skill" : "skills";
  return `${skillCount} ${noun} shared from ${sourceLabel}`;
}
