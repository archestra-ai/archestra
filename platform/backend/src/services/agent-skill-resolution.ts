import {
  isSpecCompliantSkillCompatibility,
  isSpecCompliantSkillDescription,
  isSpecCompliantSkillName,
  MAX_SKILL_COMPATIBILITY_LENGTH,
  MAX_SKILL_DESCRIPTION_LENGTH,
  TimeInMs,
} from "@archestra/shared";
import { LRUCacheManager } from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import AgentModel from "@/models/agent";
import AgentExcludedSkillModel from "@/models/agent-excluded-skill";
import AgentSkillModel from "@/models/agent-skill";
import SkillModel from "@/models/skill";
import { skillVisibleInEnvironment } from "@/services/environments/environment-isolation";
import {
  type Agent,
  type AgentType,
  GATEWAY_CAPABLE_AGENT_TYPES,
  type PublishableSkill,
  type Skill,
} from "@/types";

/**
 * The gateway facts the publication rules read.
 *
 * Structural rather than `Agent` so both agent shapes satisfy it: the gateway
 * resolves with the lean `GatewayAgent` row, while assignment validation runs
 * off the hydrated `Agent` the route already loaded.
 */
type SkillGatewayAgent = Pick<Agent, "environmentId">;

/**
 * Decides which skills a gateway connection publishes over `skill://`.
 *
 * Single source of truth for `skills/list`, `skills/get`, `resources/read` and
 * `resources/directory/read` — every one of them answers only for skills this
 * module returns, so selection, origin-scoping and the scope gate are enforced
 * in one place rather than re-derived per method.
 *
 * One authority, two shapes. The gates are predicates over a single skill, so
 * only the fetch differs: `resolveExposedSkills` reads one page for the one
 * caller that lists, and `resolveExposedSkill` reads the single row a `skill://`
 * URI names. Serving one skill through the page-shaped resolution would make
 * every file read cost a scan of the org's catalog — which it once did — so the
 * by-key path is the default and the page is the exception.
 *
 * Every gate is a SQL predicate (`publishableSkillPredicate`, plus the
 * environment and exclusion predicates each query composes), so the listing
 * pages under a `LIMIT` with no re-reading and the by-key reads return only
 * servable rows. The TypeScript twins below remain solely as a fail-closed
 * assertion — a row they reject is a predicate/assertion drift, logged as an
 * invariant violation and withheld. `skill.test.ts` pins the name and
 * file-path gates against their SQL twins.
 *
 * Two modes, mirroring how tools are attached to a gateway:
 *
 * - **Custom** (`accessAllSkills = false`) — exactly the `agent_skills` set.
 *   The assignment is the authority and deliberately diverges from the team
 *   visibility that governs in-app access: an admin attaching a skill to a
 *   gateway is publishing it to that gateway's token holders. That includes
 *   personal skills: only their author may assign one (enforced at assignment
 *   time, where a caller exists to check), and once assigned it is served to
 *   every token holder like any other skill. Environment isolation is NOT
 *   part of that divergence — like assigned tools, an assigned skill is
 *   served only while the agent's environment can see it, so a skill rebound
 *   to another environment drops off the gateway.
 * - **Auto** (`accessAllSkills = true`) — every **org-scoped** skill visible in
 *   the agent's environment, minus `agent_excluded_skills`.
 *
 * Auto is org-scope-only by design. The obvious alternative, reusing the
 * per-user skill visibility, does not survive contact with gateway auth: a
 * gateway token frequently carries no user at all (in which case that
 * resolution collapses to org scope anyway), and when it does carry one the
 * principal is the token's bound user rather than whoever is connecting — so
 * team and personal skills would leak to every holder of that token. Resolving
 * org scope directly is deterministic and independent of the principal.
 */

/**
 * Whether this pod publishes skills over MCP at all.
 *
 * Both consumers — the `initialize` capability declaration and the method
 * dispatch — read this one predicate so they can never disagree: a client is
 * never shown a capability whose methods are absent.
 *
 * It lives here rather than beside the gateway handlers because the capability
 * builder and those handlers would otherwise import each other.
 */
export function skillsSurfaceEnabled(): boolean {
  return config.mcpGateway.skillsEnabled;
}

/**
 * Whether skill publication applies to an agent type at all.
 *
 * `skill://` publication is a gateway surface: it hands skills to the MCP
 * client holding the gateway's token. An internal agent reaches skills through
 * `load_skill` inside its own runtime instead, and an LLM Proxy has no MCP
 * surface at all — neither publishes. Legacy `profile` rows are gateways under
 * an older name, so they do.
 *
 * Both ends read this one predicate so they cannot disagree: the assignment
 * service refuses a write against a type that does not publish, and the
 * resolutions below serve nothing for one — so assignments left behind by an
 * earlier build, when the editor was offered on agents too, stay off the wire
 * rather than being served by a surface with no UI to manage them.
 */
export function publishesSkills(agentType: AgentType): boolean {
  return (GATEWAY_CAPABLE_AGENT_TYPES as readonly AgentType[]).includes(
    agentType,
  );
}

/**
 * One page of the skills this gateway agent publishes, in id order (the cursor
 * key), plus whether another page follows.
 *
 * Returns null when the agent no longer exists.
 *
 * The page-shaped resolution, for `skills/list` — the one caller that lists
 * rather than addresses. Everything that answers for ONE skill goes through
 * {@link resolveExposedSkill} instead, so serving a file costs a row rather
 * than a catalog.
 *
 * Bounded by construction: every gate is a predicate of the one query, so the
 * `LIMIT` bounds the work and one round trip answers the page.
 *
 * Loads the agent with the gateway's lean lookup, not the hydrated one: all it
 * reads are scalar columns off the agents row.
 */
export async function resolveExposedSkills(params: {
  agentId: string;
  /** Resume after this skill id; omit to start at the first page. */
  afterId?: string;
  limit: number;
}): Promise<{ skills: PublishableSkill[]; hasMore: boolean } | null> {
  const agent = await AgentModel.findGatewayAgentById(params.agentId);
  if (!agent) return null;
  // An empty page rather than the null that means "no such agent": the agent
  // exists, it simply is not a publishing surface.
  if (!publishesSkills(agent.agentType)) return { skills: [], hasMore: false };

  // One more than the page, so "another page follows" is answered by the read
  // itself rather than by a second count of a set that may have moved since.
  const want = params.limit + 1;
  const batch = agent.accessAllSkills
    ? await SkillModel.findOrgScopedInEnvironment({
        organizationId: agent.organizationId,
        environmentId: agent.environmentId,
        excludedForAgentId: agent.id,
        afterId: params.afterId,
        limit: want,
      })
    : await AgentSkillModel.findSkillsByAgent({
        agentId: agent.id,
        environmentId: agent.environmentId,
        afterId: params.afterId,
        limit: want,
      });

  const exposed = batch.filter((skill) => isExposable(skill));

  return {
    skills: exposed.slice(0, params.limit),
    hasMore: exposed.length > params.limit,
  };
}

/**
 * The one skill a parsed `skill://` URI names on this gateway, or null.
 *
 * The by-key resolution `skills/get`, `resources/directory/read` and
 * `resources/read` use. A client fetching a twenty-file skill resolves twenty
 * times, so this path must not scale with the org's catalog: it reads the
 * addressed row and, in Auto mode, one exclusion probe.
 *
 * Applies exactly the gates {@link resolveExposedSkills} applies, and answers
 * null for every reason — not a publishing surface, wrong mode, excluded, out
 * of environment, unpublishable kind or name, or simply absent. A caller therefore cannot
 * tell an unexposed skill from a nonexistent one, so the surface cannot be
 * probed for which skills an org holds.
 */
export async function resolveExposedSkill(params: {
  agentId: string;
  name: string;
  /** The URI's author segment: null for a shared URI, set for a personal one. */
  authorId: string | null;
}): Promise<PublishableSkill | null> {
  const agent = await AgentModel.findGatewayAgentById(params.agentId);
  if (!agent) return null;
  if (!publishesSkills(agent.agentType)) return null;

  const key = { name: params.name, authorId: params.authorId };
  const skill = agent.accessAllSkills
    ? await resolveAutoModeSkill(agent, key)
    : await AgentSkillModel.findSkillByAgentAndUriKey({
        agentId: params.agentId,
        environmentId: agent.environmentId,
        ...key,
      });

  if (!skill || !isExposable(skill)) return null;
  return skill;
}

/**
 * Whether a skill may be attached to a gateway at all — the assignment-time
 * twin of the resolution gates.
 *
 * Checked when an admin assigns, not only when the gateway serves, so an
 * assignment that could never be published is rejected outright instead of
 * being accepted and silently dropped at read time.
 */
export function explainAssignmentRejection(params: {
  skill: Skill;
  agent: SkillGatewayAgent;
  /** The caller assigning, who must be a personal skill's author to publish it. */
  userId: string;
  /** The skill's environment assignments, for `skillVisibleInEnvironment`. */
  skillEnvironmentIds: string[];
}): string | null {
  if (params.skill.templated) {
    return `Skill "${params.skill.name}" is templated: its content is rendered per user at activation, so it has no stable published form.`;
  }
  if (params.skill.agentName) {
    return `Skill "${params.skill.name}" delegates to agent "${params.skill.agentName}", which has no equivalent over MCP.`;
  }
  // Personal skills are publishable only by their own author. The access check
  // upstream (`requireSkillsAccessible`) already limits ordinary members to
  // skills they can read; this branch closes the two paths that widen reading
  // beyond the author — `skill:admin` and per-user grants — so being shown a
  // personal skill never implies being allowed to publish it. Publication is
  // the author's call: it hands the body to every holder of the gateway's
  // token, and at serve time there is no caller to check against.
  if (
    params.skill.scope === "personal" &&
    params.skill.authorId !== params.userId
  ) {
    return `Skill "${params.skill.name}" is personal and can only be published by its author.`;
  }
  if (
    !skillVisibleInEnvironment(
      {
        sourceType: params.skill.sourceType,
        environmentIds: params.skillEnvironmentIds,
      },
      params.agent.environmentId,
    )
  ) {
    return `Skill "${params.skill.name}" is not available in this gateway's environment and cannot be published there.`;
  }
  if (!isSpecCompliantSkillName(params.skill.name)) {
    return `Skill "${params.skill.name}" has a name the Agent Skills specification does not allow (1-64 characters; lowercase letters, digits, and single hyphens), so MCP hosts would refuse it. Rename the skill to publish it.`;
  }
  if (!isSpecCompliantSkillDescription(params.skill.description)) {
    return `Skill "${params.skill.name}" has a description outside the Agent Skills limit (1-${MAX_SKILL_DESCRIPTION_LENGTH} characters), so MCP hosts would refuse it. Shorten the description to publish it.`;
  }
  if (!isSpecCompliantSkillCompatibility(params.skill.compatibility)) {
    return `Skill "${params.skill.name}" has a compatibility field over the Agent Skills limit (${MAX_SKILL_COMPATIBILITY_LENGTH} characters), so MCP hosts would refuse it. Shorten it to publish it.`;
  }
  return null;
}

// ===== Internal =====

/**
 * Fail-closed assertion that a fetched row satisfies the publication gates.
 *
 * The SQL predicate (`publishableSkillPredicate`) is the authority — no row
 * failing a gate should ever be fetched. A row rejected here means a query
 * dropped a predicate; it is withheld and logged as an invariant violation
 * rather than served.
 */
function isExposable(skill: PublishableSkill): boolean {
  const exposable =
    isPublishableType(skill) &&
    isSpecCompliantSkillName(skill.name) &&
    isSpecCompliantSkillDescription(skill.description) &&
    isSpecCompliantSkillCompatibility(skill.compatibility) &&
    // A personal skill with no author (the user row was deleted) has no author
    // URI segment, so no `skill://` URI can name it.
    !(skill.scope === "personal" && skill.authorId === null);
  if (!exposable && !driftWarnThrottle.get(skill.id)) {
    // Throttled: drift is a property of the row, not of the request, so an
    // unthrottled log repeats on every listing page the row lands in for as
    // long as it exists — which is until someone renames the skill.
    driftWarnThrottle.set(skill.id, true);
    logger.error(
      { skillId: skill.id, skillName: skill.name },
      "Invariant violation: a skill query returned a row the publication gates reject; the SQL predicates and their TypeScript twins have drifted",
    );
  }
  return exposable;
}

/** One drift report per skill per hour; see {@link isExposable}. */
const driftWarnThrottle = new LRUCacheManager<true>({
  maxSize: 1_000,
  defaultTtl: TimeInMs.Hour,
});

async function resolveAutoModeSkill(
  agent: { id: string; organizationId: string; environmentId: string | null },
  key: { name: string; authorId: string | null },
): Promise<PublishableSkill | null> {
  const skill = await SkillModel.findOrgScopedByUriKey({
    organizationId: agent.organizationId,
    environmentId: agent.environmentId,
    ...key,
  });
  if (!skill) return null;

  const excluded = await AgentExcludedSkillModel.isExcluded({
    agentId: agent.id,
    skillId: skill.id,
  });
  return excluded ? null : skill;
}

/**
 * Skill kinds that have no faithful published form.
 *
 * Templated skills render through Handlebars per activating user, so their
 * bytes are not fixed and cannot carry a stable digest. Agent-delegated skills
 * hand the task to a named agent instead of returning instructions, which has
 * no MCP counterpart — publishing the text alone would hand a client a
 * reference it cannot act on.
 */
function isPublishableType(
  skill: Pick<Skill, "templated" | "agentName">,
): boolean {
  return !skill.templated && skill.agentName === null;
}
