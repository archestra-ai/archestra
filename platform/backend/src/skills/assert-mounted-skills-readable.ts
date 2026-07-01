import { getSkillPermissionChecker } from "@/auth/skill-permissions";
import { SkillModel, SkillSandboxModel, SkillTeamModel } from "@/models";

/** Stable reason code for the revocation gate (for logs/metrics, never prose). */
type MountReadabilityFailureCode =
  | "skill_read_revoked"
  | "skill_deleted"
  | "skill_access_revoked";

/** Result of the revocation gate: ok, or a model-facing reason it failed. */
type MountReadabilityResult =
  | { ok: true }
  | { ok: false; code: MountReadabilityFailureCode; reason: string };

/**
 * Revocation gate for the materializing sandbox tools. Before a container is
 * built, every skill mounted into the sandbox must still be readable by the
 * caller: the source skill must exist in the caller's org and the caller must
 * currently hold `skill:read` and pass the skill's scope check. A skill that was
 * deleted or whose access was revoked since it was mounted fails the call —
 * fail-closed, before any bytes run. Uses the mount's denormalized `skillId`
 * (durable even after the source skill is gone) as the identity.
 */
export async function assertMountedSkillsReadable(params: {
  sandboxId: string;
  userId: string;
  organizationId: string;
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

  for (const skillId of skillIds) {
    const skill = await SkillModel.findById(skillId);
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
  }

  return { ok: true };
}
