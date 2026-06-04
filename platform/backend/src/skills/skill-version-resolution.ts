import logger from "@/logging";
import { SkillSandboxModel, SkillVersionModel } from "@/models";
import { SKILL_SANDBOX_HOME } from "@/skills-sandbox/runtime-image";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
import { asSandboxId, type Skill, type SkillVersion } from "@/types";

/**
 * Resolve the skill version a model-facing path should expose: the version
 * already mounted in the conversation's default sandbox if the skill is mounted
 * there, otherwise the skill's latest version. This is the single source of
 * truth shared by `activate_skill`, `read_skill_file`, and slash-command
 * activation, so the activation response, the mounted bytes, and `read_skill_file`
 * never diverge. Returns `null` only if the skill has no version row at all
 * (should not happen — every skill has version 1).
 */
export async function resolveEffectiveSkillVersion(params: {
  skill: Pick<Skill, "id" | "latestVersion">;
  organizationId: string;
  userId: string | undefined;
  conversationId: string | undefined;
}): Promise<SkillVersion | null> {
  if (params.userId && params.conversationId) {
    const sandbox = await SkillSandboxModel.findDefault({
      organizationId: params.organizationId,
      userId: params.userId,
      conversationId: params.conversationId,
    });
    if (sandbox) {
      const mount = await SkillSandboxModel.findMountBySkill({
        sandboxId: sandbox.id,
        skillId: params.skill.id,
      });
      if (mount) {
        const mounted = await SkillVersionModel.findById(mount.skillVersionId);
        if (mounted) return mounted;
      }
    }
  }

  return await SkillVersionModel.findBySkillAndVersion(
    params.skill.id,
    params.skill.latestVersion,
  );
}

/**
 * Resolve the version to present on activation and, when the sandbox is usable,
 * pin it by mounting it into the conversation's default sandbox. Mounting and
 * the rendered version stay in lockstep: we mount the latest version (a no-op if
 * the skill is already mounted) and then read back the authoritative pinned
 * version, so the bytes the model is shown are exactly the bytes a later
 * `run_command` will see. A mount failure is logged and swallowed — activation
 * still returns the resolved version's instructions.
 */
export async function resolveActivationVersion(params: {
  skill: Pick<Skill, "id" | "name" | "latestVersion">;
  organizationId: string;
  userId: string | undefined;
  conversationId: string | undefined;
  agentId: string | null;
  canRunSandbox: boolean;
}): Promise<SkillVersion | null> {
  if (params.canRunSandbox && params.userId && params.conversationId) {
    try {
      return await mountAndResolve({
        skill: params.skill,
        organizationId: params.organizationId,
        userId: params.userId,
        conversationId: params.conversationId,
        agentId: params.agentId,
      });
    } catch (error) {
      logger.error(
        { err: error, skillId: params.skill.id },
        "[Skills] failed to mount activated skill into sandbox",
      );
    }
  }

  return await resolveEffectiveSkillVersion({
    skill: params.skill,
    organizationId: params.organizationId,
    userId: params.userId,
    conversationId: params.conversationId,
  });
}

// === internal helpers ===

/**
 * Mount the skill's latest version into the default sandbox (idempotent) and
 * return the version actually pinned by the mount — which may be a different,
 * earlier version if the skill was already mounted in this sandbox.
 */
async function mountAndResolve(params: {
  skill: Pick<Skill, "id" | "name" | "latestVersion">;
  organizationId: string;
  userId: string;
  conversationId: string;
  agentId: string | null;
}): Promise<SkillVersion | null> {
  const latest = await SkillVersionModel.findBySkillAndVersion(
    params.skill.id,
    params.skill.latestVersion,
  );
  if (!latest) return null;

  const sandbox = await SkillSandboxModel.findOrCreateDefault({
    organizationId: params.organizationId,
    userId: params.userId,
    conversationId: params.conversationId,
    agentId: params.agentId,
    defaultCwd: SKILL_SANDBOX_HOME,
  });

  await skillSandboxRuntimeService.mountSkill({
    sandboxId: asSandboxId(sandbox.id),
    skill: {
      skillId: params.skill.id,
      skillName: params.skill.name,
      skillVersionId: latest.id,
    },
  });

  // re-read the pinned version: an already-mounted skill keeps its original
  // version, so this is authoritative even when our mount was a no-op.
  const mount = await SkillSandboxModel.findMountBySkill({
    sandboxId: sandbox.id,
    skillId: params.skill.id,
  });
  if (mount) {
    const mounted = await SkillVersionModel.findById(mount.skillVersionId);
    if (mounted) return mounted;
  }
  return latest;
}
