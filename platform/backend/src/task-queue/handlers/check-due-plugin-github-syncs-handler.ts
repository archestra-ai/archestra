import logger from "@/logging";
import { PluginModel, TaskModel } from "@/models";
import { taskQueueService } from "@/task-queue";
import { isUniqueConstraintError } from "@/utils/db";

export async function handleCheckDuePluginGithubSyncs(): Promise<void> {
  const due = await PluginModel.findDueGithubSyncs();
  const activePluginIds = await TaskModel.findActivePayloadValues(
    "plugin_github_sync",
    "pluginId",
  );
  for (const plugin of due) {
    if (activePluginIds.has(plugin.id)) continue;
    try {
      await taskQueueService.enqueue({
        taskType: "plugin_github_sync",
        payload: { pluginId: plugin.id, force: false },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      continue;
    }
    logger.debug(
      { pluginId: plugin.id },
      "[Plugins] Enqueued periodic GitHub source check",
    );
  }
}
