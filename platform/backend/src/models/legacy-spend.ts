import { createHash } from "node:crypto";
import { SupportedProvidersSchema } from "@archestra/shared/model-constants";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { schema, type Transaction } from "@/database";
import type { Model } from "@/types/model";
import {
  type PricedBillingUsage,
  priceTokens,
  sumMoney,
} from "@/utils/billable-usage";

/** Upgrade the portion of spend older releases stored without a dollar charge. */
export default class LegacySpendModel {
  /** Names with mutable legacy spend, including models absent from the catalog. */
  static async pendingModelIds(tx: Transaction): Promise<string[]> {
    const result = await tx.execute<{ model: string }>(sql`
      SELECT u.model FROM limit_model_usage u
      LEFT JOIN limit_billing_usage b ON b.limit_id = u.limit_id AND b.model = u.model
      WHERE u.current_usage_tokens_in > COALESCE(b.covered_tokens_in, 0)
         OR u.current_usage_tokens_out > COALESCE(b.covered_tokens_out, 0)
      UNION
      SELECT i.model FROM interactions i
      WHERE i.model IS NOT NULL AND i.cost IS NULL AND i.user_id IS NOT NULL
        AND i.billing_mode = 'metered' AND i.billing_team_id IS NULL
        AND i.created_at >= current_timestamp - interval '32 days'
        AND NOT EXISTS (SELECT 1 FROM interaction_billing b
          WHERE b.interaction_id = i.id AND b.usage->>'mode' IN ('enforce', 'legacy'))
    `);
    return result.rows.map((row) => row.model);
  }

  /**
   * Runs in the catalog writer's transaction, before its prices change. Covered
   * counters and receipts are the idempotency markers; no second ledger or
   * schema change is needed. Never infer historical team membership from its
   * current value: an aggregate legacy balance remains an estimate, independent
   * of request-level cost recomputation, until its existing window resets.
   */
  static async freeze(params: {
    tx: Transaction;
    modelIds: string[];
    prices: (
      model: Model | null,
      modelId: string,
    ) => {
      pricePerMillionInput: string | null;
      pricePerMillionOutput: string | null;
      source: string;
    };
  }): Promise<void> {
    const { tx, prices } = params;
    const modelIds = [...new Set(params.modelIds)];
    if (!modelIds.length) return;

    // Names can have no catalog row yet (a first sync replaces the fallback
    // rate), so row locks alone cannot serialize all price writers.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('legacy-spend:' || model, 0))
      FROM (SELECT unnest(ARRAY[${sql.join(
        modelIds.map((id) => sql`${id}`),
        sql`, `,
      )}]::text[]) AS model ORDER BY model) names`);

    // Model names in old counters have no provider. Preserve the same catalog
    // lookup the legacy reader used, and serialize concurrent catalog writers.
    const models = await tx
      .select()
      .from(schema.modelsTable)
      .where(inArray(schema.modelsTable.modelId, modelIds));
    if (models.length)
      await tx
        .select({ id: schema.modelsTable.id })
        .from(schema.modelsTable)
        .where(
          inArray(
            schema.modelsTable.id,
            models.map((model) => model.id),
          ),
        )
        .orderBy(schema.modelsTable.id)
        .for("update");
    // Read again after taking the lock: a writer may have committed while we
    // waited. The snapshot must be the price immediately before this edit.
    const lockedModels = await tx
      .select()
      .from(schema.modelsTable)
      .where(inArray(schema.modelsTable.modelId, modelIds));
    const byName = new Map<string, Model>();
    for (const model of lockedModels)
      if (!byName.has(model.modelId)) byName.set(model.modelId, model);
    const quote = (modelId: string) => {
      const rate = prices(byName.get(modelId) ?? null, modelId);
      return {
        input: rate.pricePerMillionInput,
        output: rate.pricePerMillionOutput,
        cacheRead: null,
        cacheWrite: null,
        cacheWrite1h: null,
        source: rate.source,
      };
    };

    // A default user limit's longest period is a month. Older null-cost logs
    // outside every possible active period cannot contribute to those limits.
    // Preserve timestamps and receipt identity, so retention and resets retain
    // their existing behavior. Lock logs before budgets, as backfill does.
    const i = schema.interactionsTable;
    const b = schema.interactionBillingTable;
    let afterId: string | undefined;
    while (true) {
      const rows = await tx
        .select({
          id: i.id,
          model: i.model,
          type: i.type,
          userId: i.userId,
          environmentId: i.environmentId,
          inputTokens: i.inputTokens,
          outputTokens: i.outputTokens,
          cacheReadTokens: i.cacheReadTokens,
          cacheWriteTokens: i.cacheWriteTokens,
          cacheWrite1hTokens: i.cacheWrite1hTokens,
          createdAt: sql<string>`${i.createdAt}::text`,
          organizationId: sql<string>`COALESCE(${schema.environmentsTable.organizationId}, ${schema.agentsTable.organizationId})`,
          environmentOnly: sql<boolean>`${schema.agentsTable.id} IS NULL OR ${schema.agentsTable.deletedAt} IS NOT NULL`,
        })
        .from(i)
        .leftJoin(schema.agentsTable, eq(schema.agentsTable.id, i.profileId))
        .leftJoin(
          schema.environmentsTable,
          eq(schema.environmentsTable.id, i.environmentId),
        )
        .where(
          and(
            afterId ? gt(i.id, afterId) : undefined,
            inArray(i.model, modelIds),
            sql`COALESCE(${schema.environmentsTable.organizationId}, ${schema.agentsTable.organizationId}) IS NOT NULL`,
            sql`(${schema.agentsTable.id} IS NOT NULL AND ${schema.agentsTable.deletedAt} IS NULL OR ${i.environmentId} IS NOT NULL)`,
            sql`${i.cost} IS NULL`,
            sql`${i.userId} IS NOT NULL`,
            eq(i.billingMode, "metered"),
            sql`${i.billingTeamId} IS NULL`,
            sql`${i.createdAt} >= current_timestamp - interval '32 days'`,
            sql`COALESCE(${i.response}->'__mediaUsage'->>'costAvailable', '') <> 'false'`,
            sql`NOT EXISTS (SELECT 1 FROM ${b} WHERE ${b.interactionId} = ${i.id} AND ${b.usage}->>'mode' IN ('enforce', 'legacy'))`,
          ),
        )
        .orderBy(i.id)
        .limit(500)
        .for("update", { of: i });
      if (!rows.length) break;
      // Snapshot receipts leave log.cost null. Advance past processed logs so
      // each batch does not probe every earlier receipt again.
      afterId = rows[rows.length - 1].id;
      for (const row of rows) {
        if (!row.model) continue;
        const provider = SupportedProvidersSchema.parse(row.type.split(":")[0]);
        const counts = {
          inputTokens: row.inputTokens ?? 0,
          outputTokens: row.outputTokens ?? 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheWrite1hTokens: 0,
        };
        const rates = quote(row.model);
        const cost = priceTokens(counts, rates);
        const usage: PricedBillingUsage = {
          version: 1,
          mode: "legacy",
          legacyDefaultEnvironmentOnly: row.environmentOnly,
          status: "incomplete",
          issues: ["estimated_legacy_cost"],
          cost,
          components: [
            {
              ...counts,
              id: "legacy",
              model: row.model,
              provider,
              kind: "message",
              prices: rates,
              cost,
              cacheReadTokens: row.cacheReadTokens ?? 0,
              cacheWriteTokens: row.cacheWriteTokens ?? 0,
              cacheWrite1hTokens: row.cacheWrite1hTokens ?? 0,
            },
          ],
        };
        await tx
          .insert(b)
          .values({
            interactionId: row.id,
            fingerprint: createHash("sha256")
              .update(`legacy-cost:${row.id}`)
              .digest("hex"),
            usage,
            organizationId: row.organizationId,
            environmentId: row.environmentId,
            userId: row.userId,
            billingMode: "metered",
            billingTeamId: null,
            // No historical explicit-budget allocation was recorded. Do not
            // manufacture one from current memberships or current limits.
            entities: [],
            createdAt: sql`${row.createdAt}::timestamp`,
          })
          .onConflictDoUpdate({
            target: b.interactionId,
            set: {
              usage,
              entities: [],
              createdAt: sql`${row.createdAt}::timestamp`,
              organizationId: row.organizationId,
              environmentId: row.environmentId,
              userId: row.userId,
              billingMode: "metered",
              billingTeamId: null,
            },
            setWhere: sql`${b.usage}->>'mode' NOT IN ('enforce', 'legacy')`,
          });
      }
    }

    const l = schema.limitsTable;
    const u = schema.limitModelUsageTable;
    const settled = schema.limitBillingUsageTable;
    const limits = await tx
      .select({ id: l.id })
      .from(l)
      .where(
        and(
          eq(l.limitType, "token_cost"),
          sql`${l.cleanupInterval} <> 'minute'`,
          sql`EXISTS (SELECT 1 FROM ${u} WHERE ${u.limitId} = ${l.id} AND ${inArray(u.model, modelIds)})`,
        ),
      )
      .orderBy(l.id)
      .for("no key update");
    if (!limits.length) return;
    const rows = await tx
      .select({
        limitId: u.limitId,
        model: u.model,
        input: u.currentUsageTokensIn,
        output: u.currentUsageTokensOut,
        coveredInput: settled.coveredTokensIn,
        coveredOutput: settled.coveredTokensOut,
        cost: settled.cost,
        incomplete: settled.incomplete,
      })
      .from(u)
      .leftJoin(
        settled,
        and(eq(settled.limitId, u.limitId), eq(settled.model, u.model)),
      )
      .where(
        and(
          inArray(
            u.limitId,
            limits.map((limit) => limit.id),
          ),
          inArray(u.model, modelIds),
        ),
      )
      .orderBy(u.limitId, u.model)
      .for("update", { of: u });
    for (const row of rows) {
      const inputTokens = Math.max(0, row.input - (row.coveredInput ?? 0));
      const outputTokens = Math.max(0, row.output - (row.coveredOutput ?? 0));
      if (!inputTokens && !outputTokens) continue;
      const cost = sumMoney([
        row.cost ?? "0",
        priceTokens(
          {
            inputTokens,
            outputTokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cacheWrite1hTokens: 0,
          },
          quote(row.model),
        ),
      ]);
      await tx
        .insert(settled)
        .values({
          limitId: row.limitId,
          model: row.model,
          coveredTokensIn: row.input,
          coveredTokensOut: row.output,
          cost,
          incomplete: (row.incomplete ?? 0) + 1,
        })
        .onConflictDoUpdate({
          target: [settled.limitId, settled.model],
          set: {
            coveredTokensIn: row.input,
            coveredTokensOut: row.output,
            cost,
            incomplete: (row.incomplete ?? 0) + 1,
          },
        });
    }
  }
}
