import { withDbTransaction } from "@/database";
import logger from "@/logging";
import AutoRoutingSettingsModel, {
  lockRoutingPlan,
} from "@/models/auto-routing-settings";
import OrgTrioPendingNormalTierModel, {
  type PendingNormalTier,
} from "@/models/org-trio-pending-normal-tier";
import OrganizationModel from "@/models/organization";
import { assertRuntimeAgentsSupportOrganizationDefault } from "@/services/agent-runtime/model-compatibility";
import { ApiError } from "@/types";
import { updateAutoRoutingSettings } from "./settings";

/**
 * Moves each auto-routing normal tier the org-trio migration stashed into the
 * organization's default model when the Agent Runtime agents inheriting it can
 * run it, and re-enables the auto routing the migration disabled. A row is
 * consumed with its outcome in one transaction, by one replica; a moved tier's
 * row stays, marked, until auto routing is re-enabled or its settings reject
 * that. A transient failure leaves the row for the next startup.
 */
export async function applyPendingNormalTiers(): Promise<void> {
  for (const tier of await OrgTrioPendingNormalTierModel.findAll()) {
    await applyPendingNormalTier(tier).catch((error: unknown) => {
      logger.warn(
        { err: error, organizationId: tier.organizationId },
        "[AutoRouting] The migrated auto-routing normal tier waits for the next startup",
      );
    });
  }
}

// === Internal ===

type Outcome =
  | { kind: "claimed" }
  | { kind: "incompatible"; reason: ApiError }
  | { kind: "superseded" }
  | { kind: "moved"; reenable: boolean }
  /** Moved at an earlier startup; auto routing is still to be re-enabled. */
  | { kind: "reenable" };

async function applyPendingNormalTier(stashed: PendingNormalTier) {
  const { organizationId, normalModelId } = stashed;
  const incompatibility = stashed.moved
    ? null
    : await runtimeIncompatibility(stashed);
  const outcome = await withDbTransaction(async (tx): Promise<Outcome> => {
    await lockRoutingPlan(tx, organizationId);
    const tier = await OrgTrioPendingNormalTierModel.claim(organizationId, tx);
    if (!tier) return { kind: "claimed" };
    const consume = async (result: Outcome) => {
      await OrgTrioPendingNormalTierModel.delete(organizationId, tx);
      return result;
    };
    if (!tier.moved && incompatibility)
      return consume({ kind: "incompatible", reason: incompatibility });
    await OrganizationModel.lockRowForUpdate(organizationId, tx);
    const organization = await OrganizationModel.getById(organizationId, tx);
    const settings = await AutoRoutingSettingsModel.find(organizationId, tx);
    const [defaultModelId, defaultLlmApiKeyId] = tier.moved
      ? [tier.normalModelId, tier.apiKeyId]
      : [tier.expectedDefaultModelId, tier.expectedDefaultLlmApiKeyId];
    const untouched =
      organization?.defaultModelId === defaultModelId &&
      organization?.defaultLlmApiKeyId === defaultLlmApiKeyId &&
      settings?.enabled === false;
    if (!untouched) return consume({ kind: "superseded" });
    if (tier.moved) return { kind: "reenable" };
    await OrganizationModel.patchInTransaction({
      id: organizationId,
      data: {
        defaultModelId: tier.normalModelId,
        defaultLlmApiKeyId: tier.apiKeyId,
      },
      tx,
    });
    await AutoRoutingSettingsModel.bumpGeneration(organizationId, tx);
    if (!tier.autoRoutingWasEnabled)
      return consume({ kind: "moved", reenable: false });
    await OrgTrioPendingNormalTierModel.markMoved(organizationId, tx);
    return { kind: "moved", reenable: true };
  });
  switch (outcome.kind) {
    case "claimed":
      return;
    case "incompatible":
      logger.warn(
        { err: outcome.reason, organizationId, normalModelId },
        "[AutoRouting] Kept the default model instead of the migrated auto-routing normal tier",
      );
      return;
    case "superseded":
      logger.info(
        { organizationId, normalModelId },
        "[AutoRouting] Dropped the migrated auto-routing normal tier: the default model or auto routing changed since the migration",
      );
      return;
    case "moved":
      await OrganizationModel.invalidateSettingsCaches(organizationId);
      if (outcome.reenable) await reenableAutoRouting(organizationId);
      return;
    case "reenable":
      await reenableAutoRouting(organizationId);
  }
}

/** Consumes the moved tier once auto routing is on, or its settings reject it; other errors are transient. */
async function reenableAutoRouting(organizationId: string): Promise<void> {
  try {
    await updateAutoRoutingSettings(organizationId, { enabled: true });
  } catch (error) {
    if (!(error instanceof ApiError) || error.statusCode === 409) throw error;
    logger.warn(
      { err: error, organizationId },
      "[AutoRouting] Auto routing stays disabled after the migrated normal tier moved",
    );
  }
  await OrgTrioPendingNormalTierModel.delete(organizationId);
}

/** Why an inheriting Agent Runtime agent cannot run the tier; other errors are transient. */
async function runtimeIncompatibility(
  tier: PendingNormalTier,
): Promise<ApiError | null> {
  try {
    await assertRuntimeAgentsSupportOrganizationDefault({
      organizationId: tier.organizationId,
      modelId: tier.normalModelId,
    });
    return null;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
}
