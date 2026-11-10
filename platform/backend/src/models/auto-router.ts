import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import type {
  AutoRouter,
  InsertAutoRouter,
  UpdateAutoRouter,
} from "@/types/auto-routing";

const routers = schema.autoRoutersTable;
const tiersTable = schema.autoRoutingTiersTable;
const organizations = schema.organizationsTable;
const routerKeys = schema.autoRouterVirtualApiKeysTable;

/**
 * An organization's auto routers. Each is a row of `auto_routers` with its
 * tiers in `auto_routing_tiers`; `enabled` is its organization's switch.
 */
class AutoRouterModel {
  static async find(
    routerId: string,
    tx?: Transaction,
  ): Promise<AutoRouter | null> {
    const [router] = await load(eq(routers.id, routerId), tx);
    return router ?? null;
  }

  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    return AutoRouterModel.findInOrganization(organizationId, id);
  }

  /** The router only when it belongs to the organization. */
  static async findInOrganization(
    organizationId: string,
    routerId: string,
  ): Promise<AutoRouter | null> {
    const [router] = await load(
      and(eq(routers.id, routerId), eq(routers.organizationId, organizationId)),
    );
    return router ?? null;
  }

  /** The router clients ask for as `name`. */
  static async findByName(
    organizationId: string,
    name: string,
  ): Promise<AutoRouter | null> {
    const [router] = await load(
      and(eq(routers.organizationId, organizationId), eq(routers.name, name)),
    );
    return router ?? null;
  }

  /** The organization's routers, oldest first. */
  static list(organizationId: string): Promise<AutoRouter[]> {
    return load(eq(routers.organizationId, organizationId));
  }

  /** The router that learns from the organization's scored past sessions, if it still exists. */
  static async findPastSessionsRouter(
    organizationId: string,
    tx?: Transaction,
  ): Promise<AutoRouter | null> {
    const [router] = await load(
      and(
        eq(routers.organizationId, organizationId),
        eq(routers.usesPastSessions, true),
      ),
      tx,
    );
    return router ?? null;
  }

  /**
   * Creates the router at generation 1, so its first fit is due. `validate`
   * sees it inside the transaction and throws to abort.
   */
  static async create(
    organizationId: string,
    values: InsertAutoRouter,
    validate?: (next: AutoRouter, tx: Transaction) => Promise<void>,
  ): Promise<AutoRouter> {
    return withDbTransaction(async (tx) => {
      const [row] = await tx
        .insert(routers)
        .values({
          organizationId,
          name: values.name,
          budgetUsdPerDay: values.budgetUsdPerDay,
          budgetPreset: values.budgetPreset,
          scorerApiKeyId: values.scorerApiKeyId,
          scorerModel: values.scorerModel,
          generation: 1,
        })
        .returning({ id: routers.id });
      if (values.tiers) await writeTiers(tx, row.id, values.tiers);
      const created = await AutoRouterModel.find(row.id, tx);
      if (!created) throw new Error("Created auto router could not be read");
      await validate?.(created, tx);
      return created;
    });
  }

  /**
   * Applies `update` and bumps the generation, so a fit that read the earlier
   * settings can no longer publish. An empty update only requests a re-plan.
   * `validate` sees the merged and current router under the lock and throws
   * to abort, so concurrent partial updates cannot jointly persist an invalid
   * configuration.
   * Null when the router is gone.
   */
  static async update(
    routerId: string,
    update: UpdateAutoRouter,
    validate?: (
      next: AutoRouter,
      tx: Transaction,
      current: AutoRouter,
    ) => Promise<void>,
  ): Promise<AutoRouter | null> {
    return withDbTransaction(async (tx) => {
      await lockRoutingPlan(tx, routerId);
      if (validate) {
        const current = await AutoRouterModel.find(routerId, tx);
        if (!current) return null;
        await validate(mergeRouter(current, update), tx, current);
      }
      const updated = await tx
        .update(routers)
        .set({
          name: update.name,
          budgetUsdPerDay: update.budgetUsdPerDay,
          budgetPreset: update.budgetPreset,
          scorerApiKeyId: update.scorerApiKeyId,
          scorerModel: update.scorerModel,
          generation: sql`${routers.generation} + 1`,
        })
        .where(eq(routers.id, routerId))
        .returning({ id: routers.id });
      if (updated.length === 0) return null;
      if (update.tiers) await writeTiers(tx, routerId, update.tiers);
      return AutoRouterModel.find(routerId, tx);
    });
  }

  /** Deletes the router with its tiers, plans, decisions and key assignments. */
  static async delete(
    organizationId: string,
    routerId: string,
  ): Promise<boolean> {
    return withDbTransaction(async (tx) => {
      const deleted = await tx
        .delete(routers)
        .where(
          and(
            eq(routers.id, routerId),
            eq(routers.organizationId, organizationId),
          ),
        )
        .returning({ id: routers.id });
      if (deleted.length === 0) return false;
      // OAuth clients hold their routers in metadata, which no cascade reaches.
      const metadata = schema.oauthClientsTable.metadata;
      await tx
        .update(schema.oauthClientsTable)
        .set({
          metadata: sql`jsonb_set(${metadata}, '{autoRouterIds}', COALESCE((SELECT jsonb_agg(router_id) FROM jsonb_array_elements(${metadata}->'autoRouterIds') AS router_id WHERE router_id <> to_jsonb(${routerId}::text)), '[]'::jsonb))`,
        })
        .where(
          and(
            sql`${metadata}->>'organizationId' = ${organizationId}`,
            sql`${metadata}->'autoRouterIds' @> ${JSON.stringify([routerId])}::jsonb`,
          ),
        );
      return true;
    });
  }

  /**
   * Requests a re-plan inside `tx`, under the plan lock, so the bump commits
   * with whatever made it necessary. The new generation; null when the router
   * is gone.
   */
  static async bumpGeneration(
    routerId: string,
    tx: Transaction,
  ): Promise<number | null> {
    await lockRoutingPlan(tx, routerId);
    const [row] = await tx
      .update(routers)
      .set({ generation: sql`${routers.generation} + 1` })
      .where(eq(routers.id, routerId))
      .returning({ generation: routers.generation });
    return row?.generation ?? null;
  }

  /**
   * Makes `scorerVersionId` the router's scorer version, bumping the
   * generation so plans fitted for the previous version stop serving and
   * cannot publish. Rechecked under the lock: concurrent callers bump once.
   * True when this call changed the version.
   */
  static async activateScorerVersion(
    routerId: string,
    scorerVersionId: string,
  ): Promise<boolean> {
    return withDbTransaction(async (tx) => {
      await lockRoutingPlan(tx, routerId);
      const changed = await tx
        .update(routers)
        .set({
          scorerVersionId,
          generation: sql`${routers.generation} + 1`,
        })
        .where(
          and(
            eq(routers.id, routerId),
            or(
              isNull(routers.scorerVersionId),
              ne(routers.scorerVersionId, scorerVersionId),
            ),
          ),
        )
        .returning({ id: routers.id });
      return changed.length > 0;
    });
  }

  /** The virtual keys each router is assigned to, by router id. */
  static async findVirtualApiKeyIds(
    routerIds: string[],
  ): Promise<Map<string, string[]>> {
    const byRouter = new Map<string, string[]>(routerIds.map((id) => [id, []]));
    if (routerIds.length === 0) return byRouter;
    const rows = await db
      .select()
      .from(routerKeys)
      .where(inArray(routerKeys.routerId, routerIds))
      .orderBy(asc(routerKeys.createdAt));
    for (const row of rows) {
      byRouter.get(row.routerId)?.push(row.virtualApiKeyId);
    }
    return byRouter;
  }

  /** Whether an admin assigned the router to the virtual key. */
  static async hasVirtualApiKeyGrant(
    routerId: string,
    virtualApiKeyId: string,
  ): Promise<boolean> {
    const [row] = await db
      .select({ routerId: routerKeys.routerId })
      .from(routerKeys)
      .where(
        and(
          eq(routerKeys.routerId, routerId),
          eq(routerKeys.virtualApiKeyId, virtualApiKeyId),
        ),
      );
    return row !== undefined;
  }

  /** Whether the virtual key is assigned any router. */
  static async hasAnyVirtualApiKeyGrant(
    virtualApiKeyId: string,
  ): Promise<boolean> {
    const [row] = await db
      .select({ routerId: routerKeys.routerId })
      .from(routerKeys)
      .where(eq(routerKeys.virtualApiKeyId, virtualApiKeyId))
      .limit(1);
    return row !== undefined;
  }

  /** Replaces the routers a virtual key is assigned. */
  static async setRoutersForVirtualApiKey(
    virtualApiKeyId: string,
    routerIds: string[],
  ): Promise<void> {
    const unique = [...new Set(routerIds)];
    await withDbTransaction(async (tx) => {
      await tx
        .delete(routerKeys)
        .where(eq(routerKeys.virtualApiKeyId, virtualApiKeyId));
      if (unique.length === 0) return;
      await tx
        .insert(routerKeys)
        .values(unique.map((routerId) => ({ routerId, virtualApiKeyId })));
    });
  }
}

export default AutoRouterModel;

/**
 * The one lock every writer of a router's plan-relevant state takes —
 * settings, scorer activation, re-plan requests and plan publication — so a
 * publish sees either all of a settings change or none of it.
 */
export async function lockRoutingPlan(tx: Transaction, routerId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`routing_plan:${routerId}`}, 0))`,
  );
}

export function mergeRouter(
  current: AutoRouter,
  update: UpdateAutoRouter,
): AutoRouter {
  const { tiers } = update;
  const or = <T>(next: T | undefined, value: T): T =>
    next === undefined ? value : next;
  return {
    ...current,
    name: or(update.name, current.name),
    budgetUsdPerDay: or(update.budgetUsdPerDay, current.budgetUsdPerDay),
    budgetPreset: or(update.budgetPreset, current.budgetPreset),
    scorerApiKeyId: or(update.scorerApiKeyId, current.scorerApiKeyId),
    scorerModel: or(update.scorerModel, current.scorerModel),
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

// === Internal ===

const TIER_NAMES = ["fast", "normal", "smart"] as const;
type TierName = (typeof TIER_NAMES)[number];

async function load(
  where: ReturnType<typeof and>,
  tx?: Transaction,
): Promise<AutoRouter[]> {
  const conn = tx ?? db;
  const rows = await conn
    .select({
      id: routers.id,
      organizationId: routers.organizationId,
      name: routers.name,
      enabled: organizations.autoRoutingEnabled,
      budgetUsdPerDay: routers.budgetUsdPerDay,
      budgetPreset: routers.budgetPreset,
      scorerApiKeyId: routers.scorerApiKeyId,
      scorerModel: routers.scorerModel,
      scorerVersionId: routers.scorerVersionId,
      generation: routers.generation,
      plannedGeneration: routers.plannedGeneration,
      usesPastSessions: routers.usesPastSessions,
    })
    .from(routers)
    .innerJoin(organizations, eq(organizations.id, routers.organizationId))
    .where(where)
    .orderBy(asc(routers.createdAt), asc(routers.id));
  if (rows.length === 0) return [];
  const tiers = await conn
    .select()
    .from(tiersTable)
    .where(
      inArray(
        tiersTable.routerId,
        rows.map((row) => row.id),
      ),
    );
  return rows.map((row) => {
    const tier = (name: TierName) =>
      tiers.find(
        (candidate) => candidate.routerId === row.id && candidate.tier === name,
      ) ?? null;
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
  });
}

async function writeTiers(
  tx: Transaction,
  routerId: string,
  tiers: NonNullable<UpdateAutoRouter["tiers"]>,
): Promise<void> {
  await tx
    .insert(tiersTable)
    .values(
      TIER_NAMES.map((tier) => ({
        routerId,
        tier,
        modelId: tiers[tier].modelId,
        providerApiKeyId: tiers[tier].providerApiKeyId,
      })),
    )
    .onConflictDoUpdate({
      target: [tiersTable.routerId, tiersTable.tier],
      set: {
        modelId: sql`excluded.model_id`,
        providerApiKeyId: sql`excluded.provider_api_key_id`,
      },
    });
}
