import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import type {
  AutoRoutingSettings,
  UpdateAutoRoutingSettings,
} from "@/types/auto-routing";

const agents = schema.agentsTable;
const tiersTable = schema.autoRoutingTiersTable;

/**
 * Auto-routing settings live on the organization's LLM Proxy row; its tiers
 * are rows of `auto_routing_tiers`.
 */
class AutoRoutingSettingsModel {
  static async find(
    organizationId: string,
    tx?: Transaction,
  ): Promise<AutoRoutingSettings | null> {
    const conn = tx ?? db;
    const [[row], tiers] = await Promise.all([
      conn
        .select(settingsColumns)
        .from(agents)
        .where(organizationLlmProxy(organizationId)),
      conn
        .select()
        .from(tiersTable)
        .where(eq(tiersTable.organizationId, organizationId)),
    ]);
    if (!row) return null;
    const tier = (name: TierName) =>
      tiers.find((candidate) => candidate.tier === name) ?? null;
    const [fast, normal, smart] = TIER_NAMES.map(tier);
    return {
      ...row,
      fastModelId: fast?.modelId ?? null,
      normalModelId: normal?.modelId ?? null,
      smartModelId: smart?.modelId ?? null,
      fastApiKeyId: fast?.providerApiKeyId ?? null,
      normalApiKeyId: normal?.providerApiKeyId ?? null,
      smartApiKeyId: smart?.providerApiKeyId ?? null,
    };
  }

  /**
   * Applies `update` and bumps the generation, so a fit that read the earlier
   * settings can no longer publish. An empty update only requests a re-plan.
   * `validate` sees the merged and current settings under the lock and throws
   * to abort, so concurrent partial updates cannot jointly persist an invalid
   * configuration.
   * Null when the organization has no LLM Proxy.
   */
  static async update(
    organizationId: string,
    update: UpdateAutoRoutingSettings,
    validate?: (
      next: AutoRoutingSettings,
      tx: Transaction,
      current: AutoRoutingSettings,
    ) => Promise<void>,
  ): Promise<AutoRoutingSettings | null> {
    return withDbTransaction(async (tx) => {
      await lockRoutingPlan(tx, organizationId);
      if (validate) {
        const current = await AutoRoutingSettingsModel.find(organizationId, tx);
        if (!current) return null;
        await validate(mergeSettings(current, update), tx, current);
      }
      const updated = await tx
        .update(agents)
        .set({
          autoRoutingEnabled: update.enabled,
          autoRoutingBudgetUsdPerDay: update.budgetUsdPerDay,
          autoRoutingGeneration: sql`${agents.autoRoutingGeneration} + 1`,
        })
        .where(organizationLlmProxy(organizationId))
        .returning({ id: agents.id });
      if (updated.length === 0) return null;
      if (update.tiers) {
        const { tiers } = update;
        await tx
          .insert(tiersTable)
          .values(
            TIER_NAMES.map((tier) => ({
              organizationId,
              tier,
              modelId: tiers[tier].modelId,
              providerApiKeyId: tiers[tier].providerApiKeyId,
            })),
          )
          .onConflictDoUpdate({
            target: [tiersTable.organizationId, tiersTable.tier],
            set: {
              modelId: sql`excluded.model_id`,
              providerApiKeyId: sql`excluded.provider_api_key_id`,
            },
          });
      }
      return AutoRoutingSettingsModel.find(organizationId, tx);
    });
  }

  /**
   * Requests a re-plan inside `tx`, under the plan lock, so the bump commits
   * with whatever made it necessary. The new generation; null without an LLM
   * Proxy.
   */
  static async bumpGeneration(
    organizationId: string,
    tx: Transaction,
  ): Promise<number | null> {
    await lockRoutingPlan(tx, organizationId);
    const [row] = await tx
      .update(agents)
      .set({ autoRoutingGeneration: sql`${agents.autoRoutingGeneration} + 1` })
      .where(organizationLlmProxy(organizationId))
      .returning({ generation: agents.autoRoutingGeneration });
    return row?.generation ?? null;
  }

  /**
   * Makes `scorerVersionId` the organization's scorer version, bumping the
   * generation so plans fitted for the previous version stop serving and
   * cannot publish. Rechecked under the lock: concurrent callers bump once.
   * True when this call changed the version.
   */
  static async activateScorerVersion(
    organizationId: string,
    scorerVersionId: string,
  ): Promise<boolean> {
    return withDbTransaction(async (tx) => {
      await lockRoutingPlan(tx, organizationId);
      const changed = await tx
        .update(agents)
        .set({
          autoRoutingScorerVersionId: scorerVersionId,
          autoRoutingGeneration: sql`${agents.autoRoutingGeneration} + 1`,
        })
        .where(
          and(
            organizationLlmProxy(organizationId),
            or(
              isNull(agents.autoRoutingScorerVersionId),
              ne(agents.autoRoutingScorerVersionId, scorerVersionId),
            ),
          ),
        )
        .returning({ id: agents.id });
      return changed.length > 0;
    });
  }
}

export default AutoRoutingSettingsModel;

/**
 * The one lock every writer of an organization's plan-relevant state takes —
 * settings, scorer activation, re-plan requests and plan publication — so a
 * publish sees either all of a settings change or none of it.
 */
export async function lockRoutingPlan(tx: Transaction, organizationId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`routing_plan:${organizationId}`}, 0))`,
  );
}

export function organizationLlmProxy(organizationId: string) {
  return and(
    eq(agents.organizationId, organizationId),
    eq(agents.agentType, "llm_proxy"),
    eq(agents.isDefault, true),
    notDeleted(agents),
  );
}

export function mergeSettings(
  current: AutoRoutingSettings,
  update: UpdateAutoRoutingSettings,
): AutoRoutingSettings {
  const { tiers } = update;
  return {
    ...current,
    enabled: update.enabled ?? current.enabled,
    budgetUsdPerDay:
      update.budgetUsdPerDay === undefined
        ? current.budgetUsdPerDay
        : update.budgetUsdPerDay,
    ...(tiers && {
      fastModelId: tiers.fast.modelId,
      normalModelId: tiers.normal.modelId,
      smartModelId: tiers.smart.modelId,
      fastApiKeyId: tiers.fast.providerApiKeyId,
      normalApiKeyId: tiers.normal.providerApiKeyId,
      smartApiKeyId: tiers.smart.providerApiKeyId,
    }),
  };
}

const settingsColumns = {
  enabled: agents.autoRoutingEnabled,
  budgetUsdPerDay: agents.autoRoutingBudgetUsdPerDay,
  scorerVersionId: agents.autoRoutingScorerVersionId,
  generation: agents.autoRoutingGeneration,
  plannedGeneration: agents.autoRoutingPlannedGeneration,
};

const TIER_NAMES = ["fast", "normal", "smart"] as const;
type TierName = (typeof TIER_NAMES)[number];
