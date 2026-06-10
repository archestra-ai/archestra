import logger from "@/logging";
import { SkillSandboxModel, SkillVersionModel } from "@/models";
import { executionSandboxRegistry } from "@/skills-sandbox/execution-sandbox-registry";
import { SKILL_SANDBOX_HOME } from "@/skills-sandbox/runtime-image";
import { skillSandboxRuntimeService } from "@/skills-sandbox/skill-sandbox-runtime-service";
import {
  asSandboxId,
  type Skill,
  type SkillSandbox,
  type SkillVersion,
} from "@/types";

/**
 * Outcome of resolving a skill for activation. `mounted` is true only when this
 * skill's bytes are actually pinned under `/skills/<name>` in the conversation's
 * default sandbox — callers must gate the "runnable in your sandbox" hint on it,
 * never on the agent's raw sandbox capability. A skill that lost the
 * `(sandbox, skill_name)` race to a different same-named skill resolves with
 * `mounted: false`, so the model is shown the instructions read-only and never
 * told to run code that lives under another skill's name.
 */
interface ActivationVersion {
  version: SkillVersion;
  mounted: boolean;
}

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
  /** Per-execution scope for headless runs without a conversation. */
  isolationKey?: string;
}): Promise<SkillVersion | null> {
  const sandbox = await findDefaultSandboxForScope(params);
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

  return await SkillVersionModel.findBySkillAndVersion(
    params.skill.id,
    params.skill.latestVersion,
  );
}

/**
 * Resolve the version to present on activation and, when the sandbox is usable,
 * pin it by mounting it into the conversation's default sandbox. The rendered
 * version and the `mounted` flag stay in lockstep with the bytes actually under
 * `/skills/<name>`: a successful or already-existing mount reports the pinned
 * version with `mounted: true`; a skill that could not be mounted — most
 * importantly because a *different* same-named skill already holds the mount
 * path — resolves `mounted: false` and is shown read-only. Returns `null` only
 * if the skill has no version row at all (should not happen).
 */
export async function resolveActivationVersion(params: {
  skill: Pick<Skill, "id" | "name" | "latestVersion">;
  organizationId: string;
  userId: string | undefined;
  conversationId: string | undefined;
  /** Per-execution scope for headless runs without a conversation. */
  isolationKey?: string;
  canRunSandbox: boolean;
}): Promise<ActivationVersion | null> {
  if (
    params.canRunSandbox &&
    params.userId &&
    (params.conversationId || params.isolationKey)
  ) {
    try {
      return await mountAndResolve({
        skill: params.skill,
        organizationId: params.organizationId,
        userId: params.userId,
        conversationId: params.conversationId,
        isolationKey: params.isolationKey,
      });
    } catch (error) {
      logger.error(
        { err: error, skillId: params.skill.id },
        "[Skills] failed to mount activated skill into sandbox",
      );
    }
  }

  const version = await resolveEffectiveSkillVersion({
    skill: params.skill,
    organizationId: params.organizationId,
    userId: params.userId,
    conversationId: params.conversationId,
    isolationKey: params.isolationKey,
  });
  return version ? { version, mounted: false } : null;
}

// === internal helpers ===

/**
 * Mount the skill's latest version into the default sandbox and report what the
 * mount path actually holds. The mount is idempotent per skill, but it can also
 * fail the `(sandbox, skill_name)` unique constraint when a different skill of
 * the same name is already mounted there; that failure is swallowed and the
 * result is `mounted: false`, since `/skills/<name>` belongs to the other skill.
 * `mounted: true` is returned only when a mount row for *this* skill exists, so
 * the rendered/pinned version can never claim another skill's bytes.
 */
async function mountAndResolve(params: {
  skill: Pick<Skill, "id" | "name" | "latestVersion">;
  organizationId: string;
  userId: string;
  conversationId: string | undefined;
  isolationKey: string | undefined;
}): Promise<ActivationVersion | null> {
  const latest = await SkillVersionModel.findBySkillAndVersion(
    params.skill.id,
    params.skill.latestVersion,
  );
  if (!latest) return null;

  let sandbox: SkillSandbox;
  if (params.conversationId) {
    sandbox = await SkillSandboxModel.findOrCreateDefault({
      organizationId: params.organizationId,
      userId: params.userId,
      conversationId: params.conversationId,
      defaultCwd: SKILL_SANDBOX_HOME,
    });
  } else if (params.isolationKey) {
    sandbox = await executionSandboxRegistry.getOrCreateDefault({
      organizationId: params.organizationId,
      userId: params.userId,
      isolationKey: params.isolationKey,
      defaultCwd: SKILL_SANDBOX_HOME,
    });
  } else {
    throw new Error(
      "mountAndResolve requires a conversation or an isolation scope",
    );
  }

  try {
    await skillSandboxRuntimeService.mountSkill({
      sandboxId: asSandboxId(sandbox.id),
      skill: {
        skillId: params.skill.id,
        skillName: params.skill.name,
        skillVersionId: latest.id,
      },
    });
  } catch (error) {
    // a same-name collision (unique(sandbox, skill_name)) means a different
    // skill already occupies /skills/<name>; fall through and report unmounted.
    logger.error(
      { err: error, skillId: params.skill.id },
      "[Skills] failed to mount activated skill into sandbox",
    );
  }

  // only a mount row for THIS skill makes it runnable under /skills/<name>.
  const mount = await SkillSandboxModel.findMountBySkill({
    sandboxId: sandbox.id,
    skillId: params.skill.id,
  });
  if (mount) {
    const mounted = await SkillVersionModel.findById(mount.skillVersionId);
    if (mounted) return { version: mounted, mounted: true };
  }
  // the mount did not land for this skill (name collision / transient failure):
  // show the latest version read-only, never advertising sandbox runnability.
  return { version: latest, mounted: false };
}

/**
 * The default sandbox the caller's scope resolves to, without creating one:
 * the conversation's default sandbox in chat, the execution's sandbox in
 * headless runs, null when neither scope applies or nothing was created yet.
 */
async function findDefaultSandboxForScope(params: {
  organizationId: string;
  userId: string | undefined;
  conversationId: string | undefined;
  isolationKey?: string;
}): Promise<SkillSandbox | null> {
  if (!params.userId) return null;
  if (params.conversationId) {
    return await SkillSandboxModel.findDefault({
      organizationId: params.organizationId,
      userId: params.userId,
      conversationId: params.conversationId,
    });
  }
  if (params.isolationKey) {
    return await executionSandboxRegistry.findDefault({
      organizationId: params.organizationId,
      userId: params.userId,
      isolationKey: params.isolationKey,
    });
  }
  return null;
}
