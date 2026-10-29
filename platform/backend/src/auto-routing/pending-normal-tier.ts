import db, { schema } from "@/database";
import logger from "@/logging";
import OrganizationModel from "@/models/organization";
import { assertRuntimeAgentsSupportOrganizationDefault } from "@/services/agent-runtime/model-compatibility";
import { updateAutoRoutingSettings, writeOrganizationTrio } from "./settings";

type PendingNormalTier =
  typeof schema.orgTrioPendingNormalTierTable.$inferSelect;

/**
 * Moves each auto-routing normal tier the org-trio migration stashed into the
 * organization's default model when the Agent Runtime agents inheriting it can
 * run it, and re-enables the auto routing the migration disabled. The delete
 * hands each row to exactly one booting replica.
 */
export async function applyPendingNormalTiers(): Promise<void> {
  const pending = await db
    .delete(schema.orgTrioPendingNormalTierTable)
    .returning();
  for (const tier of pending) await applyPendingNormalTier(tier);
}

async function applyPendingNormalTier(tier: PendingNormalTier) {
  const { organizationId, normalModelId, apiKeyId } = tier;
  try {
    await assertRuntimeAgentsSupportOrganizationDefault({
      organizationId,
      modelId: normalModelId,
    });
    await writeOrganizationTrio({
      organizationId,
      patch: { normalModelId },
      write: (tx) =>
        OrganizationModel.patchInTransaction({
          id: organizationId,
          data: { defaultModelId: normalModelId, defaultLlmApiKeyId: apiKeyId },
          tx,
        }),
    }).finally(() =>
      OrganizationModel.invalidateSettingsCaches(organizationId),
    );
  } catch (error) {
    logger.warn(
      { err: error, organizationId, normalModelId },
      "[AutoRouting] Kept the default model instead of the migrated auto-routing normal tier",
    );
    return;
  }
  if (!tier.autoRoutingWasEnabled) return;
  await updateAutoRoutingSettings(organizationId, { enabled: true }).catch(
    (error: unknown) => {
      logger.warn(
        { err: error, organizationId },
        "[AutoRouting] Auto routing stays disabled after the migrated normal tier moved",
      );
    },
  );
}
