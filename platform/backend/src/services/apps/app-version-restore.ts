import { AppModel, AppVersionModel } from "@/models";
import { syncAppBacking } from "@/services/apps/app-mcp-backing";
import { buildValidatedVersionPayload } from "@/services/apps/app-ui-policy";
import { ApiError, type App } from "@/types";

/**
 * Restore an immutable app version by copying its artifact forward as a new
 * head. The historical row is never changed, and a byte-identical restore is
 * a no-op. Current validation still applies so history cannot bypass newer
 * authoring safeguards.
 */
export async function restoreAppVersion(params: {
  appId: string;
  version: number;
  baseVersion: number;
}): Promise<{ app: App; warnings: string[] }> {
  const source = await AppVersionModel.findByAppAndVersion(
    params.appId,
    params.version,
  );
  if (!source) {
    throw new ApiError(
      404,
      `App ${params.appId} has no version ${params.version}.`,
    );
  }

  const validated = await buildValidatedVersionPayload({
    html: source.html,
    uiPermissions: source.uiPermissions,
  });
  const app = await AppModel.update({
    id: params.appId,
    version: validated.payload,
    expectedLatestVersion: params.baseVersion,
  });
  if (!app) {
    throw new ApiError(404, `No app found with id ${params.appId}.`);
  }

  await syncAppBacking(app);
  return { app, warnings: validated.warnings };
}
