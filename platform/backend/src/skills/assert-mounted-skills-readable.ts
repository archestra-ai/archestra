import { getSkillPermissionChecker } from "@/auth/skill-permissions";
import {
  AgentModel,
  SkillEnvironmentModel,
  SkillModel,
  SkillSandboxModel,
  SkillTeamModel,
} from "@/models";
import { agentActivationSkillPolicyService } from "@/services/agent-activation-skill-policy";
import { skillVisibleInEnvironment } from "@/services/environments/environment-isolation";

/** Stable reason code for the revocation gate (for logs/metrics, never prose). */
type MountReadabilityFailureCode =
  | "skill_read_revoked"
  | "skill_deleted"
  | "skill_access_revoked"
  | "skill_environment_revoked"
  | "skill_agent_policy_revoked";

/** Result of the revocation gate: ok, or a model-facing reason it failed. */
type MountReadabilityResult =
  | { ok: true }
  | { ok: false; code: MountReadabilityFailureCode; reason: string };

/**
 * Revocation gate for the materializing sandbox tools. Before a container is
 * built, every skill mounted into the sandbox must still be readable by the
 * caller: the source skill must exist in the caller's org and the caller must
 * currently hold `skill:read`, pass the skill's scope check, and—when this is
 * an agent call—remain visible in the agent's current environment and allowed
 * by its activation policy. A skill that was deleted or revoked since it was
 * mounted fails the call before any bytes run. Uses the mount's denormalized
 * `skillId` as the identity.
 */
export async function assertMountedSkillsReadable(params: {
  sandboxId: string;
  userId: string;
  organizationId: string;
  agentId?: string;
}): Promise<MountReadabilityResult> {
  const skillIds = await SkillSandboxModel.listMountedSkillIds(
    params.sandboxId,
  );
  if (skillIds.length === 0) return { ok: true };

  const checker = await getSkillPermissionChecker({
    userId: params.userId,
    organizationId: params.organizationId,
  });
  if (!checker.canRead) {
    return {
      ok: false,
      code: "skill_read_revoked",
      reason:
        "you no longer have permission to read the skills mounted in this sandbox",
    };
  }
  const [policyEvaluator, agent, skills, environmentIdsBySkill] =
    await Promise.all([
      params.agentId
        ? agentActivationSkillPolicyService.getEvaluator(params.agentId)
        : null,
      params.agentId ? AgentModel.findById(params.agentId) : null,
      SkillModel.findByIds(skillIds),
      SkillEnvironmentModel.getEnvironmentIdsForSkills(skillIds),
    ]);
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));

  for (const skillId of skillIds) {
    const skill = skillsById.get(skillId);
    if (!skill || skill.organizationId !== params.organizationId) {
      return {
        ok: false,
        code: "skill_deleted",
        reason:
          "a skill mounted in this sandbox no longer exists; start a fresh sandbox to continue",
      };
    }
    const hasAccess = await SkillTeamModel.userHasSkillAccess({
      organizationId: params.organizationId,
      userId: params.userId,
      skill,
      isSkillAdmin: checker.isAdmin,
    });
    if (!hasAccess) {
      return {
        ok: false,
        code: "skill_access_revoked",
        reason: `you no longer have access to the skill "${skill.name}" mounted in this sandbox`,
      };
    }
    if (
      params.agentId &&
      (!agent ||
        agent.organizationId !== params.organizationId ||
        !skillVisibleInEnvironment(
          {
            sourceType: skill.sourceType,
            environmentIds: environmentIdsBySkill.get(skill.id) ?? [],
          },
          agent.environmentId ?? null,
        ))
    ) {
      return {
        ok: false,
        code: "skill_environment_revoked",
        reason: `the skill "${skill.name}" mounted in this sandbox is no longer available in this agent's environment`,
      };
    }
    if (
      policyEvaluator !== null &&
      !policyEvaluator.isReferenceAllowed({
        source: "native",
        skillId: skill.id,
      })
    ) {
      return {
        ok: false,
        code: "skill_agent_policy_revoked",
        reason: `the skill "${skill.name}" mounted in this sandbox is no longer enabled for this agent`,
      };
    }
  }

  return { ok: true };
}
