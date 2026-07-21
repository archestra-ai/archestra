import logger from "@/logging";
import { SkillModel } from "@/models";
import {
  resolveGithubAppInstallationToken,
  resolveGithubPatToken,
} from "@/skills/github-app-token";
import { importSkills } from "@/skills/github-import";
import { isSkillNameConflict, toSkillInsertFields } from "@/skills/validation";
import { ApiError, type Skill } from "@/types";

/**
 * Pull one GitHub-synced skill from its source repo. Re-fetches the skill at
 * its tracking ref (`githubSyncRef`, null = default branch), and when the
 * resolved commit moved past `sourceCommit`, replaces the skill's content and
 * files via `updateWithFiles` (forking a new immutable version). Archestra-side
 * management — scope, teams, environment, usage stats — is never touched.
 *
 * The handler always resolves: every outcome (success, unchanged, failure) is
 * stamped on the row via `markGithubSyncResult`, and a failed pull keeps the
 * last good content. No task-queue retry — the next scheduled interval is the
 * retry.
 */
export async function handleSkillGithubSync(
  payload: Record<string, unknown>,
): Promise<void> {
  const skillId = typeof payload.skillId === "string" ? payload.skillId : null;
  if (!skillId) {
    throw new Error("Missing skillId in skill GitHub sync payload");
  }

  const skill = await SkillModel.findById(skillId);
  // deleted or disconnected while the task sat in the queue — nothing to do.
  if (!skill || skill.githubSyncInterval === null) return;

  try {
    await syncSkill(skill);
    await SkillModel.markGithubSyncResult(skill.id, null);
  } catch (error) {
    const message = syncErrorMessage(error);
    logger.warn(
      { skillId: skill.id, skillName: skill.name, error: message },
      "[Skills] GitHub sync failed; keeping last synced content",
    );
    await SkillModel.markGithubSyncResult(skill.id, message);
  }
}

// ===== Internal helpers =====

async function syncSkill(skill: Skill): Promise<void> {
  const source = parseSourceRef(skill.sourceRef);
  if (!source) {
    throw new Error(
      `Skill has an unparsable source reference (${skill.sourceRef ?? "none"})`,
    );
  }

  // a synced skill authenticates with its stored credential: a saved PAT or
  // a GitHub App config; neither means an unauthenticated (public) pull.
  const githubToken = skill.githubPatId
    ? await resolveGithubPatToken({
        githubPatId: skill.githubPatId,
        organizationId: skill.organizationId,
      })
    : skill.githubAppConfigId
      ? await resolveGithubAppInstallationToken({
          githubAppConfigId: skill.githubAppConfigId,
          organizationId: skill.organizationId,
        })
      : undefined;

  // convey the tracking ref through the URL form parseRepoUrl understands;
  // no ref tracks the repo's default branch (HEAD) on every pull.
  const repoUrl =
    `https://github.com/${source.owner}/${source.repo}` +
    (skill.githubSyncRef ? `/tree/${skill.githubSyncRef}` : "");

  const [imported] = await importSkills({
    repoUrl,
    githubToken,
    skillPaths: [source.skillPath],
  });
  if (!imported) {
    throw new Error(`No skill found at ${source.skillPath}`);
  }

  if (imported.sourceCommit === skill.sourceCommit) {
    logger.debug(
      { skillId: skill.id, commit: skill.sourceCommit },
      "[Skills] GitHub sync: source unchanged",
    );
    return;
  }

  try {
    await SkillModel.updateWithFiles({
      id: skill.id,
      skill: {
        ...toSkillInsertFields(imported.parsed),
        sourceRef: imported.sourceRef,
        sourceCommit: imported.sourceCommit,
      },
      files: imported.files,
    });
  } catch (error) {
    if (isSkillNameConflict(error)) {
      throw new Error(
        `The skill was renamed to "${imported.parsed.name}" upstream, but a skill with that name already exists here`,
      );
    }
    throw error;
  }

  logger.info(
    {
      skillId: skill.id,
      skillName: imported.parsed.name,
      commit: imported.sourceCommit,
      skippedFiles: imported.skippedFiles.length,
    },
    "[Skills] GitHub sync: skill updated from source",
  );
}

/** Split a `owner/repo@ref:path` provenance string; path may be empty. */
function parseSourceRef(
  sourceRef: string | null,
): { owner: string; repo: string; skillPath: string } | null {
  if (!sourceRef) return null;
  const atIdx = sourceRef.indexOf("@");
  if (atIdx === -1) return null;
  const [owner, repo] = sourceRef.slice(0, atIdx).split("/");
  if (!owner || !repo) return null;
  const colonIdx = sourceRef.indexOf(":", atIdx);
  if (colonIdx === -1) return null;
  return { owner, repo, skillPath: sourceRef.slice(colonIdx + 1) };
}

function syncErrorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) {
    return error.message;
  }
  return String(error);
}
