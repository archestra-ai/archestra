import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import type {
  AutoRoutingSettings,
  AutoRoutingTrio,
  UpdateAutoRoutingSettings,
} from "@/types/auto-routing";

const agents = schema.agentsTable;
const organizations = schema.organizationsTable;

/**
 * Auto-routing settings live on the organization's LLM Proxy row; its tiers
 * are the organization's default model trio.
 */
class AutoRoutingSettingsModel {
  static async find(
    organizationId: string,
    tx?: Transaction,
  ): Promise<AutoRoutingSettings | null> {
    const [row] = await (tx ?? db)
      .select(settingsColumns)
      .from(agents)
      .innerJoin(organizations, eq(organizations.id, agents.organizationId))
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
      return AutoRoutingSettingsModel.find(organizationId, tx);
    });
  }

  /**
   * Runs `write`, a change of the organization's model trio, under the
   * routing-plan lock and bumps the generation, so the plan is re-fitted for
   * the new tiers. `validate` sees the settings over the next trio and throws
   * to abort.
   */
  static async updateTrio<T>(params: {
    organizationId: string;
    /** The tiers the write sets; the others keep their current models. */
    patch: Partial<AutoRoutingTrio>;
    validate: (
      next: AutoRoutingSettings,
      tx: Transaction,
      current: AutoRoutingSettings,
    ) => Promise<void>;
    write: (tx: Transaction) => Promise<T>;
  }): Promise<T> {
    return withDbTransaction(async (tx) => {
      await lockRoutingPlan(tx, params.organizationId);
      const current = await AutoRoutingSettingsModel.find(
        params.organizationId,
        tx,
      );
      const next = current ? { ...current, ...params.patch } : null;
      const changed =
        current !== null &&
        next !== null &&
        (next.fastModelId !== current.fastModelId ||
          next.normalModelId !== current.normalModelId ||
          next.smartModelId !== current.smartModelId);
      if (changed) await params.validate(next, tx, current);
      const written = await params.write(tx);
      if (changed) {
        await tx
          .update(agents)
          .set({
            autoRoutingGeneration: sql`${agents.autoRoutingGeneration} + 1`,
          })
          .where(organizationLlmProxy(params.organizationId));
      }
      return written;
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
  };
}

const settingsColumns = {
  enabled: agents.autoRoutingEnabled,
  budgetUsdPerDay: agents.autoRoutingBudgetUsdPerDay,
  fastModelId: organizations.defaultFastModelId,
  normalModelId: organizations.defaultModelId,
  smartModelId: organizations.defaultSmartModelId,
  scorerVersionId: agents.autoRoutingScorerVersionId,
  generation: agents.autoRoutingGeneration,
  plannedGeneration: agents.autoRoutingPlannedGeneration,
};
