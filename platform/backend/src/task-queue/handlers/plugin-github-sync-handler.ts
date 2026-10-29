import logger from "@/logging";
import { PluginModel } from "@/models";
import { importPluginFromGithub } from "@/plugins/github-import";
import { resolvePluginSourceAccess } from "@/plugins/plugin-source-access";

/**
 * Checks one tracked source. Executable bytes are never auto-published: a new
 * commit becomes a pinned pending candidate that an administrator must review
 * and approve through the existing apply-update route.
 */
export async function handlePluginGithubSync(
  payload: Record<string, unknown>,
): Promise<void> {
  const pluginId =
    typeof payload.pluginId === "string" ? payload.pluginId : null;
  if (!pluginId) throw new Error("Missing pluginId in Plugin Git sync payload");

  const due = await PluginModel.findByIdForSync(pluginId);
  if (
    !due ||
    !due.sourceRepo ||
    (due.githubSyncInterval === null && payload.force !== true)
  ) {
    return;
  }

  try {
    const access = await resolvePluginSourceAccess(due);
    const imported = await importPluginFromGithub({
      repoUrl: due.sourceRepo,
      ref: due.githubSyncRef,
      trackingRef: due.githubSyncRef,
      subdir: due.sourceSubdir ?? "",
      exclude: due.sourceExclude,
      access,
    });
    await PluginModel.markGithubSyncResult({
      id: due.id,
      expectedSyncGeneration: due.syncGeneration,
      expectedPendingSourceSha: due.pendingSourceSha,
      sourceSha: imported.commitSha,
      files: imported.files,
      error: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      { pluginId: due.id, error: message },
      "[Plugins] Git source check failed; keeping approved bytes",
    );
    await PluginModel.markGithubSyncResult({
      id: due.id,
      expectedSyncGeneration: due.syncGeneration,
      expectedPendingSourceSha: due.pendingSourceSha,
      error: message,
    });
  }
}
