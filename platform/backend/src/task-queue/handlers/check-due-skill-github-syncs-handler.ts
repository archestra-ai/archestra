import logger from "@/logging";
import { SkillModel, TaskModel } from "@/models";
import { taskQueueService } from "@/task-queue";

/**
 * Periodic tick that fans out GitHub skill syncs: every GitHub-synced skill
 * whose interval (15m/1h/1d) has elapsed since its last sync gets one
 * `skill_github_sync` task, unless one is already pending or running.
 */
export async function handleCheckDueSkillGithubSyncs(): Promise<void> {
  const due = await SkillModel.findDueGithubSyncs();
  if (due.length === 0) return;

  // One query instead of a per-skill EXISTS check.
  const activeSkillIds = await TaskModel.findActivePayloadValues(
    "skill_github_sync",
    "skillId",
  );

  for (const skill of due) {
    if (activeSkillIds.has(skill.id)) continue;
    await taskQueueService.enqueue({
      taskType: "skill_github_sync",
      payload: { skillId: skill.id },
    });
    logger.info(
      { skillId: skill.id, skillName: skill.name },
      "[Skills] Enqueued scheduled GitHub sync",
    );
  }
}
