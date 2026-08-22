import logger from "@/logging";
import { PluginModel } from "@/models";
import { importPluginFromGithub } from "@/plugins/github-import";
import {
  resolveGithubAppInstallationToken,
  resolveGithubPatToken,
} from "@/skills/github-app-token";

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
  if (!pluginId)
    throw new Error("Missing pluginId in Plugin GitHub sync payload");

  const due = await PluginModel.findByIdForSync(pluginId);
  if (
    !due ||
    !due.sourceRepo ||
    (due.githubSyncInterval === null && payload.force !== true)
  ) {
    return;
  }

  try {
    const githubToken = due.githubPatId
      ? await resolveGithubPatToken({
          githubPatId: due.githubPatId,
          organizationId: due.organizationId,
        })
      : due.githubAppConfigId
        ? await resolveGithubAppInstallationToken({
            githubAppConfigId: due.githubAppConfigId,
            organizationId: due.organizationId,
          })
        : undefined;
    const imported = await importPluginFromGithub({
      repoUrl: due.sourceRepo,
      ref: due.githubSyncRef,
      trackingRef: due.githubSyncRef,
      subdir: due.sourceSubdir ?? "",
      exclude: due.sourceExclude,
      githubToken,
    });
    await PluginModel.markGithubSyncResult({
      id: due.id,
      expectedSyncGeneration: due.syncGeneration,
      sourceSha: imported.commitSha,
      files: imported.files,
      error: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      { pluginId: due.id, error: message },
      "[Plugins] GitHub source check failed; keeping approved bytes",
    );
    await PluginModel.markGithubSyncResult({
      id: due.id,
      expectedSyncGeneration: due.syncGeneration,
      error: message,
    });
  }
}
