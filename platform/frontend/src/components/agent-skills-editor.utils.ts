import { isSpecCompliantSkillName } from "@archestra/shared";

/**
 * Which skills a gateway can publish over `skill://`, decided in the UI.
 *
 * These rules mirror `explainAssignmentRejection` in the backend's
 * agent-skill-resolution service. They are duplicated here on purpose: the API
 * is the authority and rejects a bad assignment with a 422, but an admin should
 * see why a skill is unavailable in the picker rather than discover it by
 * having a save fail. If the backend rules change, change these with them.
 */

export interface SkillPublishability {
  publishable: boolean;
  /** Why the skill cannot be published, phrased for the picker. Null when it can. */
  reason: string | null;
}

export interface SkillLike {
  name: string;
  scope: string;
  templated?: boolean | null;
  agentName?: string | null;
  authorId?: string | null;
  /**
   * The environments the skill is restricted to, empty meaning "every
   * environment". Carried by the paginated catalog rows the picker is built
   * from; omitted by the rows the assignment endpoints return, which is why
   * the environment gate below fails open when it is absent.
   */
  environments?: ReadonlyArray<{ id: string }> | null;
  /** Built-in skills are exempt from the environment gate. */
  sourceType?: string | null;
}

export interface GatewayLike {
  /**
   * The environment the gateway will be saved into — the pending selection,
   * not the stored one, since the agent update lands before the skills PUT.
   */
  environmentId?: string | null;
}

export function getSkillPublishability(params: {
  skill: SkillLike;
  gateway: GatewayLike | null | undefined;
  /**
   * The signed-in user, who must be a personal skill's author to publish it.
   * Fails closed while the session is still loading: an unknown caller can
   * publish no personal skill.
   */
  currentUserId: string | null | undefined;
}): SkillPublishability {
  const { skill, gateway, currentUserId } = params;
  if (skill.templated) {
    return {
      publishable: false,
      reason:
        "Templated — rendered per user, so it has no fixed published form",
    };
  }
  if (skill.agentName) {
    return {
      publishable: false,
      reason: `Delegates to agent "${skill.agentName}" — no equivalent over MCP`,
    };
  }
  if (skill.scope === "personal" && !isAuthoredBy(skill, currentUserId)) {
    return {
      publishable: false,
      reason: "Personal — only its author can publish it",
    };
  }
  if (!isVisibleInEnvironment(skill, gateway)) {
    return {
      publishable: false,
      reason:
        "Restricted to other environments — add this one to the skill to publish it here",
    };
  }
  if (!isSpecCompliantSkillName(skill.name)) {
    return {
      publishable: false,
      reason:
        "Name breaks the Agent Skills naming rules (lowercase letters, digits, single hyphens) — rename to publish",
    };
  }
  return { publishable: true, reason: null };
}

/**
 * The disclosure shown for a publishable personal skill: unlike in-app
 * visibility, publication serves the body to every holder of the gateway's
 * token, and that is worth saying before the author opts in.
 */
export function getPersonalSkillPublishWarning(
  skill: SkillLike,
): string | null {
  return skill.scope === "personal"
    ? "Personal skill — published here, it is served to everyone holding this gateway's token"
    : null;
}

// === internal ===

/**
 * Whether the signed-in user authored the skill. Fails closed on both sides:
 * a missing session and a personal skill with no recorded author both match
 * nothing, so `null === null` never reads as authorship.
 */
function isAuthoredBy(
  skill: SkillLike,
  currentUserId: string | null | undefined,
): boolean {
  return currentUserId != null && skill.authorId === currentUserId;
}

/**
 * Mirrors the backend's `skillVisibleInEnvironment`: a skill restricted to a
 * set of environments can only be published by a gateway sitting in one of
 * them, while an unrestricted skill — and every built-in — publishes anywhere.
 *
 * Fails open when the row carries no `environments`. Those rows come from the
 * assignment endpoints, so they describe skills that are already assigned;
 * disabling them on a guess would strand chips an admin needs to remove.
 */
function isVisibleInEnvironment(
  skill: SkillLike,
  gateway: GatewayLike | null | undefined,
): boolean {
  if (skill.sourceType === "built_in") return true;
  if (!skill.environments || skill.environments.length === 0) return true;
  const gatewayEnvironmentId = gateway?.environmentId ?? null;
  if (gatewayEnvironmentId === null) return false;
  return skill.environments.some((env) => env.id === gatewayEnvironmentId);
}
