import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import type {
  AutoRoutingSettings,
  UpdateAutoRoutingSettings,
} from "@/types/auto-routing";

const agents = schema.agentsTable;

/** Auto-routing settings live on the organization's LLM Proxy row. */
class AutoRoutingSettingsModel {
  static async find(
    organizationId: string,
  ): Promise<AutoRoutingSettings | null> {
    const [row] = await db
      .select(settingsColumns)
      .from(agents)
      .where(organizationLlmProxy(organizationId));
    return row ?? null;
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
        const [current] = await tx
          .select(settingsColumns)
          .from(agents)
          .where(organizationLlmProxy(organizationId));
        if (!current) return null;
        await validate(mergeSettings(current, update), tx, current);
      }
      const [row] = await tx
        .update(agents)
        .set({
          autoRoutingEnabled: update.enabled,
          autoRoutingBudgetUsdPerDay: update.budgetUsdPerDay,
          autoRoutingFastModelId: update.fastModelId,
          autoRoutingNormalModelId: update.normalModelId,
          autoRoutingSmartModelId: update.smartModelId,
          autoRoutingGeneration: sql`${agents.autoRoutingGeneration} + 1`,
        })
        .where(organizationLlmProxy(organizationId))
        .returning(settingsColumns);
      return row ?? null;
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
  return {
    ...current,
    enabled: update.enabled ?? current.enabled,
    budgetUsdPerDay:
      update.budgetUsdPerDay === undefined
        ? current.budgetUsdPerDay
        : update.budgetUsdPerDay,
    fastModelId:
      update.fastModelId === undefined
        ? current.fastModelId
        : update.fastModelId,
    normalModelId:
      update.normalModelId === undefined
        ? current.normalModelId
        : update.normalModelId,
    smartModelId:
      update.smartModelId === undefined
        ? current.smartModelId
        : update.smartModelId,
  };
}

const settingsColumns = {
  enabled: agents.autoRoutingEnabled,
  budgetUsdPerDay: agents.autoRoutingBudgetUsdPerDay,
  fastModelId: agents.autoRoutingFastModelId,
  normalModelId: agents.autoRoutingNormalModelId,
  smartModelId: agents.autoRoutingSmartModelId,
  scorerVersionId: agents.autoRoutingScorerVersionId,
  generation: agents.autoRoutingGeneration,
  plannedGeneration: agents.autoRoutingPlannedGeneration,
};
