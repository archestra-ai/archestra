import { and, eq, sql } from "drizzle-orm";
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
   * Null when the organization has no LLM Proxy.
   */
  static async update(
    organizationId: string,
    update: UpdateAutoRoutingSettings,
  ): Promise<AutoRoutingSettings | null> {
    return withDbTransaction(async (tx) => {
      await lockRoutingPlan(tx, organizationId);
      const [row] = await tx
        .update(agents)
        .set({
          autoRoutingEnabled: update.enabled,
          autoRoutingBudgetUsdPerDay: update.budgetUsdPerDay,
          autoRoutingFastModelId: update.fastModelId,
          autoRoutingNormalModelId: update.normalModelId,
          autoRoutingSmartModelId: update.smartModelId,
          autoRoutingScorerVersionId: update.scorerVersionId,
          autoRoutingGeneration: sql`${agents.autoRoutingGeneration} + 1`,
        })
        .where(organizationLlmProxy(organizationId))
        .returning(settingsColumns);
      return row ?? null;
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
