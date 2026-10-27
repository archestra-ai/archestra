import { ApiError } from "@archestra/shared/types";
import {
  and,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import config from "@/config";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import { PreparedQuery } from "@/database/prepared-query";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import logger from "@/logging";
import type {
  CreateLimit,
  CredentialSpendCap,
  CredentialSpendCapInput,
  EnvironmentDefaultUserLimit,
  LabelWithDetails,
  Limit,
  LimitCleanupInterval,
  LimitEntityType,
  LimitType,
  Model,
  UpdateLimit,
} from "@/types";
import { BudgetCleanupIntervalSchema, CreateLimitSchema } from "@/types";
import type {
  BillingAttribution,
  PricedBillingUsage,
} from "@/utils/billable-usage";
import { priceTokens, sumMoney } from "@/utils/billable-usage";
import { retryOnceOnDeadlock } from "@/utils/deadlock";
import AgentModel from "./agent";
import AgentTeamModel, { type AgentTeamSource } from "./agent-team";
import CacheEntryModel from "./cache-entry";
import { LimitLabelModel } from "./entity-labels";
import EnvironmentDefaultUserLimitModel from "./environment-default-user-limit";
import {
  limitEntitiesCondition,
  limitEntityParameters,
} from "./limit-entity-scope";
import LlmThroughputModel from "./llm-throughput";
import ModelModel from "./model";
import type { ProxyRequestState } from "./proxy-request-context";

type LimitsCleanupOptionsEntities = {
  [K in Exclude<LimitEntityType, "team" | "virtual_key">]?: string;
} & {
  [K in Extract<LimitEntityType, "team">]?: string[];
} & {
  virtual_key?: string | string[];
};

type LimitsCleanupOptions = {
  entities?: LimitsCleanupOptionsEntities;
  entityType?: LimitEntityType;
  entityId?: string;
  limitType?: LimitType;
  allForOrganizationId?: string;
};

type LimitsCleanupIntervalSqlLiteral =
  | "1 hour"
  | "12 hours"
  | "24 hours"
  | "1 week"
  | "1 month";
type RollingLimitCleanupInterval = Extract<
  LimitCleanupInterval,
  "1h" | "12h" | "24h" | "1w" | "1m"
>;

type LimitModelUsageRecord = typeof schema.limitModelUsageTable.$inferSelect & {
  coveredTokensIn: number | null;
  coveredTokensOut: number | null;
  settledCost: string | null;
  incomplete: number | null;
};
const usageSelection = {
  ...getTableColumns(schema.limitModelUsageTable),
  coveredTokensIn: schema.limitBillingUsageTable.coveredTokensIn,
  coveredTokensOut: schema.limitBillingUsageTable.coveredTokensOut,
  settledCost: schema.limitBillingUsageTable.cost,
  incomplete: schema.limitBillingUsageTable.incomplete,
};
const billingJoin = and(
  eq(
    schema.limitModelUsageTable.limitId,
    schema.limitBillingUsageTable.limitId,
  ),
  eq(schema.limitModelUsageTable.model, schema.limitBillingUsageTable.model),
);
type ModelUsageBreakdown = {
  model: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;
};

// Data batch-loaded once per request and shared across the priority-ordered
// entity checks, so token_cost limit evaluation issues no per-entity queries.
type LimitPrefetch = {
  limitsByEntity: Map<string, Limit[]>;
  usageByLimitId: Map<string, LimitModelUsageRecord[]>;
  pricingByModelId: Map<string, Model>;
};
type LimitViolationResponse = [
  refusalMessage: string,
  contentMessage: string,
  metadata?: {
    entityType: LimitEntityType;
    limitType: "token_cost";
  },
];

const DEFAULT_LIMIT_CLEANUP_INTERVAL: LimitCleanupInterval = "calendar_month";

/** A limit row with its labels attached, as the listing endpoint returns it. */
type LimitWithLabels = Limit & { labels: LabelWithDetails[] };

class LimitModel {
  // rollingCleanupIntervalSqlLiterals exists to compile-time check rolling literals.
  static readonly rollingCleanupIntervalSqlLiterals: Record<
    RollingLimitCleanupInterval,
    LimitsCleanupIntervalSqlLiteral
  > = {
    "1h": "1 hour",
    "12h": "12 hours",
    "24h": "24 hours",
    "1w": "1 week",
    "1m": "1 month",
  };
  /**
   * Create a new limit
   */
  static async create(data: CreateLimit): Promise<LimitWithLabels> {
    if (
      data.limitType === "requests_per_minute" ||
      data.limitType === "tokens_per_minute" ||
      data.limitType === "requests" ||
      data.limitType === "tokens" ||
      data.limitType === "token_cost" ||
      data.cleanupInterval === "minute"
    ) {
      data = CreateLimitSchema.parse(data);
    }
    const { labels, ...columns } = data;
    const [limit] = await db
      .insert(schema.limitsTable)
      .values({
        ...columns,
        cleanupInterval: data.cleanupInterval ?? DEFAULT_LIMIT_CLEANUP_INTERVAL,
      })
      .returning();

    // For token_cost limits, initialize model usage records
    if (
      limit.limitType === "token_cost" &&
      limit.model &&
      Array.isArray(limit.model)
    ) {
      await LimitModel.initializeModelUsageRecords(limit.id, limit.model);
    }

    if (labels?.length) {
      await LimitLabelModel.syncLabels(limit.id, labels);
    }

    return { ...limit, labels: await LimitLabelModel.getLabelsFor(limit.id) };
  }

  /**
   * Initialize model usage records for a limit
   * Creates a record in limit_model_usage for each model in the limit
   */
  static async initializeModelUsageRecords(
    limitId: string,
    models: string[],
  ): Promise<void> {
    if (!models || models.length === 0) {
      return;
    }

    const records = models.map((model) => ({
      limitId,
      model,
      currentUsageTokensIn: 0,
      currentUsageTokensOut: 0,
    }));

    await db.insert(schema.limitModelUsageTable).values(records);

    logger.info(
      `[LimitModel] Initialized ${models.length} model usage records for limit ${limitId}`,
    );
  }

  /**
   * Find all limits, optionally filtered by entity type, entity ID, and/or limit type
   */
  static async findAll(
    entityType?: LimitEntityType,
    entityId?: string,
    limitType?: LimitType,
    organizationId?: string,
    labels?: Record<string, string[]>,
  ): Promise<LimitWithLabels[]> {
    const labelFilteredIds = labels
      ? await LimitLabelModel.getIdsMatchingLabels(labels)
      : null;
    if (labelFilteredIds?.length === 0) {
      return [];
    }

    const whereConditions: SQL[] = [];

    if (labelFilteredIds) {
      whereConditions.push(inArray(schema.limitsTable.id, labelFilteredIds));
    }

    if (organizationId) {
      whereConditions.push(
        buildOrganizationLimitScopeCondition(organizationId),
      );
    }

    if (entityType) {
      whereConditions.push(eq(schema.limitsTable.entityType, entityType));
    }

    if (entityId) {
      whereConditions.push(eq(schema.limitsTable.entityId, entityId));
    }

    if (limitType) {
      whereConditions.push(eq(schema.limitsTable.limitType, limitType));
    }

    const whereClause =
      whereConditions.length > 0 ? and(...whereConditions) : undefined;

    const limits = await db
      .select()
      .from(schema.limitsTable)
      .where(whereClause);

    const labelsById = await LimitLabelModel.getLabelsForMany(
      limits.map((limit) => limit.id),
    );

    return limits.map((limit) => ({
      ...limit,
      labels: labelsById.get(limit.id) ?? [],
    }));
  }

  /**
   * Per-model usage of several token_cost limits, keyed by limit id. One usage
   * read and one price lookup for any number of limits.
   */
  static async getModelUsageBreakdowns(
    limitIds: string[],
  ): Promise<Map<string, ModelUsageBreakdown[]>> {
    const breakdowns = new Map<string, ModelUsageBreakdown[]>(
      limitIds.map((id) => [id, []]),
    );
    if (limitIds.length === 0) return breakdowns;

    const modelUsages = await db
      .select(usageSelection)
      .from(schema.limitModelUsageTable)
      .leftJoin(schema.limitBillingUsageTable, billingJoin)
      .where(inArray(schema.limitModelUsageTable.limitId, limitIds));
    const pricing = await ModelModel.findByModelIdsOnly([
      ...new Set(modelUsages.map((usage) => usage.model)),
    ]);

    const usagesByLimitId = new Map<string, LimitModelUsageRecord[]>();
    for (const usage of modelUsages) {
      const list = usagesByLimitId.get(usage.limitId) ?? [];
      list.push(usage);
      usagesByLimitId.set(usage.limitId, list);
    }
    for (const [limitId, usages] of usagesByLimitId) {
      breakdowns.set(
        limitId,
        computeModelUsageCosts(usages, pricing).breakdown,
      );
    }
    return breakdowns;
  }

  /**
   * Current cost of several token_cost limits, keyed by limit id. `incomplete`
   * marks a limit whose usage includes unpriced media, which enforcement
   * treats as exhausted.
   */
  static async getTokenCostTotals(
    limitIds: string[],
  ): Promise<Map<string, { cost: number; incomplete: boolean }>> {
    const totals = new Map<string, { cost: number; incomplete: boolean }>(
      limitIds.map((id) => [id, { cost: 0, incomplete: false }]),
    );
    if (limitIds.length === 0) return totals;

    const modelUsages = await db
      .select(usageSelection)
      .from(schema.limitModelUsageTable)
      .leftJoin(schema.limitBillingUsageTable, billingJoin)
      .where(inArray(schema.limitModelUsageTable.limitId, limitIds));
    const pricing = await ModelModel.findByModelIdsOnly([
      ...new Set(modelUsages.map((usage) => usage.model)),
    ]);
    const usagesByLimitId = new Map<string, LimitModelUsageRecord[]>();
    for (const usage of modelUsages) {
      const list = usagesByLimitId.get(usage.limitId) ?? [];
      list.push(usage);
      usagesByLimitId.set(usage.limitId, list);
    }
    for (const [limitId, usages] of usagesByLimitId) {
      const { cost, incomplete } = computeModelUsageCosts(usages, pricing);
      totals.set(limitId, { cost, incomplete });
    }
    return totals;
  }

  /**
   * How many users spent in each environment inside the window, keyed by
   * environment id. Same counting rules as `getDefaultUserLimitUsageByUser`.
   */
  static async countUsersWithSpendByEnvironment(params: {
    organizationId: string;
    cleanupInterval: LimitCleanupInterval;
  }): Promise<Map<string, number>> {
    const interactions = schema.interactionsTable;
    const rows = await db
      .select({
        environmentId: sql<string>`${interactions.environmentId}`,
        users: sql<number>`count(distinct ${interactions.userId})::integer`,
      })
      .from(interactions)
      .innerJoin(
        schema.environmentsTable,
        eq(interactions.environmentId, schema.environmentsTable.id),
      )
      .where(
        and(
          eq(schema.environmentsTable.organizationId, params.organizationId),
          isNotNull(interactions.userId),
          eq(interactions.billingMode, "metered"),
          isNull(interactions.billingTeamId),
          buildUsagePeriodStartCondition(params.cleanupInterval),
        ),
      )
      .groupBy(interactions.environmentId);
    return new Map(rows.map((row) => [row.environmentId, row.users]));
  }

  /**
   * Spend counted toward a default user limit, for every user at once, keyed
   * by user id. Same rules as the per-request check (metered, not team-billed,
   * inside the window, after the user's last reset, within `models`), but
   * aggregated in SQL so an organization-wide read stays one round trip.
   * Users without spend are absent from the map.
   */
  static async getDefaultUserLimitUsageByUser(params: {
    organizationId: string;
    models: string[] | null;
    cleanupInterval: LimitCleanupInterval;
    /** Count only this environment's spend; omit for the whole organization. */
    environmentId?: string | null;
  }): Promise<Map<string, { cost: number; incomplete: boolean }>> {
    const interactions = schema.interactionsTable;
    const costUnavailable = sql`coalesce(${interactions.response}->'__mediaUsage'->>'costAvailable' = 'false', false)`;
    const conditions: SQL[] = [
      isNotNull(interactions.userId),
      eq(interactions.billingMode, "metered"),
      isNull(interactions.billingTeamId),
      buildUsagePeriodStartCondition(params.cleanupInterval),
      buildAfterUsageResetCondition({
        organizationId: params.organizationId,
        userId: interactions.userId,
        createdAt: interactions.createdAt,
      }),
      sql`NOT EXISTS (SELECT 1 FROM ${schema.interactionBillingTable} WHERE ${schema.interactionBillingTable.interactionId} = ${interactions.id} AND ${schema.interactionBillingTable.usage}->>'mode' = 'enforce')`,
    ];
    if (params.models && params.models.length > 0) {
      conditions.push(inArray(interactions.model, params.models) as SQL);
    }

    const selection = {
      userId: sql<string>`${interactions.userId}`,
      model: interactions.model,
      knownCost: sql<string>`coalesce(sum(${interactions.cost}) FILTER (WHERE ${interactions.cost} IS NOT NULL AND NOT ${costUnavailable}), 0)::text`,
      unpricedTokensIn: sql<number>`coalesce(sum(${interactions.inputTokens}) FILTER (WHERE ${interactions.cost} IS NULL AND NOT ${costUnavailable}), 0)::bigint`,
      unpricedTokensOut: sql<number>`coalesce(sum(${interactions.outputTokens}) FILTER (WHERE ${interactions.cost} IS NULL AND NOT ${costUnavailable}), 0)::bigint`,
      unavailable: sql<boolean>`bool_or(${costUnavailable})`,
    };
    // Mirrors getDefaultUserLimitUsage: an environment filter uses the
    // environment snapshotted on the interaction; the organization-wide sum
    // goes through the (not deleted) agent's organization.
    const groups = params.environmentId
      ? await db
          .select(selection)
          .from(interactions)
          .where(
            and(
              ...conditions,
              eq(interactions.environmentId, params.environmentId),
            ),
          )
          .groupBy(interactions.userId, interactions.model)
      : await db
          .select(selection)
          .from(interactions)
          .innerJoin(
            schema.agentsTable,
            eq(interactions.profileId, schema.agentsTable.id),
          )
          .where(
            and(
              ...conditions,
              eq(schema.agentsTable.organizationId, params.organizationId),
              notDeleted(schema.agentsTable),
            ),
          )
          .groupBy(interactions.userId, interactions.model);

    const pricing = await ModelModel.findByModelIdsOnly([
      ...new Set(
        groups
          .filter(
            (group) =>
              group.model !== null &&
              (Number(group.unpricedTokensIn) > 0 ||
                Number(group.unpricedTokensOut) > 0),
          )
          .map((group) => group.model as string),
      ),
    ]);

    const costs = new Map<string, string>();
    const incomplete = new Set<string>();
    for (const group of groups) {
      if (group.unavailable) incomplete.add(group.userId);
      let groupCost = group.knownCost;
      if (group.model) {
        const modelPricing = ModelModel.getEffectivePricing(
          pricing.get(group.model) ?? null,
          group.model,
        );
        groupCost = sumMoney([
          groupCost,
          priceTokens(
            {
              inputTokens: Number(group.unpricedTokensIn),
              outputTokens: Number(group.unpricedTokensOut),
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              cacheWrite1hTokens: 0,
            },
            {
              input: modelPricing.pricePerMillionInput,
              output: modelPricing.pricePerMillionOutput,
              cacheRead: null,
              cacheWrite: null,
              cacheWrite1h: null,
              source: modelPricing.source,
            },
          ),
        ]);
      }
      costs.set(
        group.userId,
        sumMoney([costs.get(group.userId) ?? "0", groupCost]),
      );
    }

    const receipt = schema.interactionBillingTable;
    const componentMatches = params.models?.length
      ? inArray(sql`component->>'model'`, params.models)
      : sql`true`;
    const settled = await db
      .select({
        userId: sql<string>`${receipt.userId}`,
        cost: sql<string>`COALESCE(sum((component->>'cost')::numeric) FILTER (WHERE ${componentMatches}), 0)::text`,
        incomplete: sql<number>`count(*) FILTER (WHERE ${receipt.usage}->>'status' = 'incomplete')::integer`,
      })
      .from(receipt)
      .leftJoin(
        sql`LATERAL jsonb_array_elements(${receipt.usage}->'components') AS component`,
        sql`true`,
      )
      .where(
        and(
          eq(receipt.organizationId, params.organizationId),
          isNotNull(receipt.userId),
          eq(receipt.billingMode, "metered"),
          isNull(receipt.billingTeamId),
          sql`${receipt.usage}->>'mode' = 'enforce'`,
          buildUsagePeriodStartCondition(
            params.cleanupInterval,
            receipt.createdAt,
          ),
          buildAfterUsageResetCondition({
            organizationId: params.organizationId,
            userId: receipt.userId,
            createdAt: receipt.createdAt,
          }),
          params.environmentId
            ? eq(receipt.environmentId, params.environmentId)
            : undefined,
        ),
      )
      .groupBy(receipt.userId);
    for (const row of settled) {
      if (row.incomplete > 0) incomplete.add(row.userId);
      costs.set(row.userId, sumMoney([costs.get(row.userId) ?? "0", row.cost]));
    }

    return new Map(
      [...costs].map(([userId, cost]) => [
        userId,
        { cost: Number(cost), incomplete: incomplete.has(userId) },
      ]),
    );
  }

  /**
   * Get raw model usage records for a limit (primarily for testing)
   * Returns the raw database records from limitModelUsageTable
   */
  static async getRawModelUsage(limitId: string): Promise<
    Array<{
      model: string;
      currentUsageTokensIn: number;
      currentUsageTokensOut: number;
    }>
  > {
    logger.debug({ limitId }, "LimitModel.getRawModelUsage: fetching records");
    const records = await db
      .select(usageSelection)
      .from(schema.limitModelUsageTable)
      .leftJoin(schema.limitBillingUsageTable, billingJoin)
      .where(eq(schema.limitModelUsageTable.limitId, limitId));

    logger.debug(
      { limitId, count: records.length },
      "LimitModel.getRawModelUsage: completed",
    );
    return records;
  }

  /**
   * Find a limit by ID
   */
  static async findById(id: string): Promise<Limit | null> {
    const [limit] = await db
      .select()
      .from(schema.limitsTable)
      .where(eq(schema.limitsTable.id, id));

    return limit || null;
  }

  /**
   * Loads requested limits only when their owning entity belongs to the
   * organization. Limits do not carry an organization id directly, so this
   * reuses the same entity-based scope predicate as every org-scoped limit read.
   */
  static async findByIdsInOrganization(
    ids: string[],
    organizationId: string,
  ): Promise<Limit[]> {
    if (ids.length === 0) return [];

    return db
      .select()
      .from(schema.limitsTable)
      .where(
        and(
          inArray(schema.limitsTable.id, ids),
          buildOrganizationLimitScopeCondition(organizationId),
        ),
      );
  }

  /**
   * Patch a limit
   */
  static async patch(
    id: string,
    data: Partial<UpdateLimit>,
  ): Promise<LimitWithLabels | null> {
    const { labels, ...columns } = data;
    // Normalize empty model array to null for consistent "all models" behavior
    const patchData = { ...columns };
    if (
      patchData.model !== undefined &&
      (!patchData.model ||
        (Array.isArray(patchData.model) && patchData.model.length === 0))
    ) {
      patchData.model = null;
    }

    const [limit] = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cache-entry:llm-throughput:${id}`}, 0))`,
      );
      const [existingLimit] = await tx
        .select()
        .from(schema.limitsTable)
        .where(eq(schema.limitsTable.id, id))
        .limit(1);

      if (!existingLimit) {
        return [];
      }

      if (
        [existingLimit.limitType, patchData.limitType].some(
          (type) =>
            type === "requests_per_minute" ||
            type === "tokens_per_minute" ||
            type === "requests" ||
            type === "tokens",
        ) ||
        patchData.cleanupInterval === "minute" ||
        existingLimit.cleanupInterval === "minute" ||
        existingLimit.limitType === "token_cost"
      ) {
        const validated = CreateLimitSchema.safeParse({
          ...existingLimit,
          ...patchData,
        });
        if (!validated.success)
          throw new ApiError(400, "Invalid limit configuration");
      }
      if (
        patchData.limitType &&
        patchData.limitType !== existingLimit.limitType &&
        patchData.limitType !==
          existingLimit.limitType.replace("_per_minute", "")
      ) {
        throw new ApiError(
          400,
          "Create a separate limit to change its throughput dimension",
        );
      }
      if (
        (patchData.entityType &&
          patchData.entityType !== existingLimit.entityType) ||
        (patchData.entityId && patchData.entityId !== existingLimit.entityId)
      )
        throw new ApiError(400, "Create a separate limit to change its scope");

      const shouldResetUsage =
        patchData.cleanupInterval !== undefined &&
        patchData.cleanupInterval !== existingLimit.cleanupInterval;
      const limitPatchData = shouldResetUsage
        ? {
            ...patchData,
            // JS dates retain milliseconds. Keep interval epochs distinct even
            // for rapid edits or a database clock moving backwards.
            lastCleanup: sql`greatest(clock_timestamp(), ${schema.limitsTable.lastCleanup} + interval '1 millisecond')`,
          }
        : patchData;

      const updatedLimits = await tx
        .update(schema.limitsTable)
        .set(limitPatchData)
        .where(eq(schema.limitsTable.id, id))
        .returning();

      if (updatedLimits[0]) {
        await LlmThroughputModel.reconfigure({
          entries: new CacheEntryModel(tx),
          limit: updatedLimits[0],
        });
      }

      if (shouldResetUsage) {
        await tx
          .delete(schema.limitBillingUsageTable)
          .where(eq(schema.limitBillingUsageTable.limitId, id));
        await tx
          .update(schema.limitModelUsageTable)
          .set({
            currentUsageTokensIn: 0,
            currentUsageTokensOut: 0,
          })
          .where(eq(schema.limitModelUsageTable.limitId, id));
      }

      return updatedLimits;
    });

    if (!limit) {
      return null;
    }

    // Only touch labels when the caller sent them, so a patch that omits the
    // field leaves existing labels alone.
    if (labels !== undefined) {
      await LimitLabelModel.syncLabels(id, labels);
    }

    return { ...limit, labels: await LimitLabelModel.getLabelsFor(id) };
  }

  /**
   * Delete a limit
   */
  static async delete(id: string): Promise<boolean> {
    return (await LimitModel.deleteMany([id])).length > 0;
  }

  /** Deletes an already organization-fenced batch in one statement. */
  static async deleteMany(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return [];

    return CacheEntryModel.withLocks(
      ids.map((id) => `llm-throughput:${id}`),
      async (entries, tx) => {
        const deleted = await tx
          .delete(schema.limitsTable)
          .where(inArray(schema.limitsTable.id, ids))
          .returning();
        await LlmThroughputModel.deleteCounters(entries, deleted);
        return deleted.map(({ id }) => id);
      },
    );
  }

  /**
   * The spend cap of each credential: its oldest all-models `token_cost`
   * limit, with the billed spend of the current window. Other limits on the
   * same credential (model-scoped ones made on the limits page) are left to
   * that page.
   */
  static async findSpendCaps(params: {
    entityType: Extract<LimitEntityType, "virtual_key" | "llm_oauth_client">;
    entityIds: string[];
  }): Promise<Map<string, CredentialSpendCap>> {
    if (params.entityIds.length === 0) return new Map();
    const rows = await db
      .select()
      .from(schema.limitsTable)
      .where(
        and(
          eq(schema.limitsTable.entityType, params.entityType),
          inArray(schema.limitsTable.entityId, params.entityIds),
          eq(schema.limitsTable.limitType, "token_cost"),
          sql`${schema.limitsTable.cleanupInterval} <> 'minute'`,
          isNull(schema.limitsTable.model),
        ),
      )
      .orderBy(schema.limitsTable.createdAt, schema.limitsTable.id);
    const capRows = new Map<string, Limit>();
    for (const row of rows) {
      if (!capRows.has(row.entityId)) capRows.set(row.entityId, row as Limit);
    }
    if (capRows.size === 0) return new Map();

    const usages = await db
      .select(usageSelection)
      .from(schema.limitModelUsageTable)
      .leftJoin(schema.limitBillingUsageTable, billingJoin)
      .where(
        inArray(
          schema.limitModelUsageTable.limitId,
          [...capRows.values()].map((row) => row.id),
        ),
      );
    const usagesByLimitId = new Map<string, LimitModelUsageRecord[]>();
    for (const usage of usages) {
      const list = usagesByLimitId.get(usage.limitId) ?? [];
      list.push(usage);
      usagesByLimitId.set(usage.limitId, list);
    }
    const pricing = await ModelModel.findByModelIdsOnly([
      ...new Set(usages.map((usage) => usage.model)),
    ]);

    const caps = new Map<string, CredentialSpendCap>();
    for (const [entityId, row] of capRows) {
      caps.set(entityId, {
        limitId: row.id,
        limitValue: row.limitValue,
        cleanupInterval: BudgetCleanupIntervalSchema.parse(
          row.cleanupInterval ?? DEFAULT_LIMIT_CLEANUP_INTERVAL,
        ),
        currentUsage: computeModelUsageCosts(
          usagesByLimitId.get(row.id) ?? [],
          pricing,
        ).cost,
      });
    }
    return caps;
  }

  /**
   * Create, change, or remove a credential's spend cap (see
   * {@link LimitModel.findSpendCaps}). `null` removes it.
   */
  static async setSpendCap(params: {
    entityType: Extract<LimitEntityType, "virtual_key" | "llm_oauth_client">;
    entityId: string;
    cap: CredentialSpendCapInput | null;
  }): Promise<void> {
    const existing = (
      await LimitModel.findSpendCaps({
        entityType: params.entityType,
        entityIds: [params.entityId],
      })
    ).get(params.entityId);

    if (!params.cap) {
      if (existing) await LimitModel.delete(existing.limitId);
      return;
    }
    if (!existing) {
      await LimitModel.create({
        entityType: params.entityType,
        entityId: params.entityId,
        limitType: "token_cost",
        limitValue: params.cap.limitValue,
        cleanupInterval: params.cap.cleanupInterval,
        model: null,
      });
      return;
    }
    if (
      existing.limitValue !== params.cap.limitValue ||
      existing.cleanupInterval !== params.cap.cleanupInterval
    ) {
      await LimitModel.patch(existing.limitId, params.cap);
    }
  }

  /** Remove every limit set on one entity, e.g. a deleted credential. */
  static async deleteForEntity(params: {
    entityType: LimitEntityType;
    entityId: string;
  }): Promise<void> {
    const limits = await db
      .select({ id: schema.limitsTable.id })
      .from(schema.limitsTable)
      .where(
        and(
          eq(schema.limitsTable.entityType, params.entityType),
          eq(schema.limitsTable.entityId, params.entityId),
        ),
      );
    await LimitModel.deleteMany(limits.map(({ id }) => id));
  }

  /**
   * Exact-string swaps of the name-keyed limit columns after an MCP catalog
   * rename, so limits keyed to `mcpServerName` / `toolName` keep matching
   * the renamed server and tools instead of silently going stale.
   */
  static async renameNameKeys(
    params: {
      serverNamePairs: Array<{ oldName: string; newName: string }>;
      toolNamePairs: Array<{ oldName: string; newName: string }>;
    },
    tx?: Transaction,
  ): Promise<void> {
    const executor = tx ?? db;
    for (const { oldName, newName } of params.serverNamePairs) {
      if (oldName === newName) continue;
      await executor
        .update(schema.limitsTable)
        .set({ mcpServerName: newName })
        .where(eq(schema.limitsTable.mcpServerName, oldName));
    }
    for (const { oldName, newName } of params.toolNamePairs) {
      if (oldName === newName) continue;
      await executor
        .update(schema.limitsTable)
        .set({ toolName: newName })
        .where(eq(schema.limitsTable.toolName, oldName));
    }
  }

  /**
   * Get token usage for a specific agent
   * Returns the sum of input and output tokens from all interactions
   */
  static async getAgentTokenUsage(agentId: string): Promise<{
    agentId: string;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
  }> {
    const result = await db
      .select({
        totalInputTokens: sql<number>`COALESCE(SUM(${schema.interactionsTable.inputTokens}), 0)`,
        totalOutputTokens: sql<number>`COALESCE(SUM(${schema.interactionsTable.outputTokens}), 0)`,
      })
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.profileId, agentId));

    const totalInputTokens = Number(result[0]?.totalInputTokens || 0);
    const totalOutputTokens = Number(result[0]?.totalOutputTokens || 0);

    return {
      agentId,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
    };
  }

  /**
   * Update token usage for limits of a specific entity and model
   * Used by usage tracking service after interactions
   */
  static async updateTokenLimitUsage(
    entityType: LimitEntityType,
    entityId: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): Promise<void> {
    logger.debug(
      { entityType, entityId, model, inputTokens, outputTokens },
      "[LimitModel] Update token limit usage",
    );
    try {
      await LimitModel.addTokenUsage({
        entityRefs: sql`VALUES (${entityType}, ${entityId})`,
        model,
        inputTokens,
        outputTokens,
      });
    } catch (error) {
      logger.error(
        `Error updating ${entityType} token limit for ${entityId}, model ${model}: ${error}`,
      );
      // Don't throw - continue with other updates
    }
  }

  /**
   * Add one interaction's tokens to every token_cost limit it reaches, in a
   * single statement. Besides the agent and `entities`, the interaction reaches
   * each of `teamIds` and one organization: a team's when the agent has teams,
   * otherwise the agent's own.
   */
  static async recordInteractionTokenUsage(params: {
    agentId: string;
    teamIds: string[];
    entities: Array<{ entityType: LimitEntityType; entityId: string }>;
    model: string;
    inputTokens: number;
    outputTokens: number;
    tx?: Transaction;
    attribution?: BillingAttribution;
  }): Promise<void> {
    const { agentId, teamIds, entities, tx, attribution, ...usage } = params;
    if (attribution) {
      if (!attribution.entities.length) return;
      await LimitModel.addTokenUsage({
        ...usage,
        tx,
        entityRefs: sql`VALUES ${sql.join(
          attribution.entities.map(
            ({ entityType, entityId }) => sql`(${entityType}, ${entityId})`,
          ),
          sql`, `,
        )}`,
      });
      return;
    }
    const team = schema.teamsTable;
    const agent = schema.agentsTable;
    const literalRefs = sql.join(
      [
        sql`(${"agent"}, ${agentId})`,
        ...entities.map(
          ({ entityType, entityId }) => sql`(${entityType}, ${entityId})`,
        ),
      ],
      sql`, `,
    );
    const derivedRefs =
      teamIds.length === 0
        ? sql`SELECT ${"organization"}, ${agent.organizationId} FROM ${agent}
            WHERE ${agent.id} = ${agentId} AND ${notDeleted(agent)}`
        : sql`SELECT ${"team"}, ${team.id} FROM ${team}
            WHERE ${inArray(team.id, teamIds)}
            UNION ALL
            (SELECT ${"organization"}, ${team.organizationId} FROM ${team}
              WHERE ${inArray(team.id, teamIds)} LIMIT 1)`;

    await LimitModel.addTokenUsage({
      entityRefs: sql`VALUES ${literalRefs} UNION ALL ${derivedRefs}`,
      ...usage,
    });
  }

  /** All amounts and price snapshots were resolved before entering the transaction. */
  static async settleBillableUsage(params: {
    tx: Transaction;
    attribution: BillingAttribution;
    usage: PricedBillingUsage;
  }): Promise<void> {
    const { tx, attribution, usage } = params;
    if (!attribution.entities.length) return;
    const conditions = attribution.entities.map(({ entityType, entityId }) =>
      and(
        eq(schema.limitsTable.entityType, entityType),
        eq(schema.limitsTable.entityId, entityId),
      ),
    );
    // A parent lock serializes settlement with resets, even for cache-only rows
    // whose legacy input/output counters are zero. Always lock in id order.
    const limits = await tx
      .select()
      .from(schema.limitsTable)
      .where(
        and(
          eq(schema.limitsTable.limitType, "token_cost"),
          sql`${schema.limitsTable.cleanupInterval} <> 'minute'`,
          or(...conditions),
        ),
      )
      .orderBy(schema.limitsTable.id)
      .for("no key update");
    const models = [
      ...new Set(usage.components.map((item) => item.model)),
    ].sort();
    const legacyRows: (typeof schema.limitModelUsageTable.$inferInsert)[] = [];
    const settledRows: (typeof schema.limitBillingUsageTable.$inferInsert)[] =
      [];
    const grouped = new Map(
      models.map((model) => {
        const components = usage.components.filter(
          (item) => item.model === model,
        );
        return [
          model,
          {
            input: components.reduce((sum, item) => sum + item.inputTokens, 0),
            output: components.reduce(
              (sum, item) => sum + item.outputTokens,
              0,
            ),
            cost: sumMoney(components.map((item) => item.cost)),
          },
        ];
      }),
    );
    for (const limit of limits) {
      const matched = models.filter(
        (model) => !limit.model?.length || limit.model.includes(model),
      );
      for (const model of matched) {
        const total = grouped.get(model);
        if (!total) continue;
        legacyRows.push({
          limitId: limit.id,
          model,
          currentUsageTokensIn: total.input,
          currentUsageTokensOut: total.output,
        });
        settledRows.push({
          limitId: limit.id,
          model,
          coveredTokensIn: total.input,
          coveredTokensOut: total.output,
          cost: total.cost,
          incomplete: usage.status === "incomplete" ? 1 : 0,
        });
      }
      // An unmatched unknown model must still block the budget until reset.
      if (usage.status === "incomplete" && !matched.length) {
        const model =
          "urn:archestra:billing:incomplete:5707b463-67d0-4e54-a8f4-2c3897e186ba";
        legacyRows.push({ limitId: limit.id, model });
        settledRows.push({
          limitId: limit.id,
          model,
          incomplete: 1,
        });
      }
    }
    if (!legacyRows.length) return;
    const legacy = schema.limitModelUsageTable;
    await tx
      .insert(legacy)
      .values(legacyRows)
      .onConflictDoUpdate({
        target: [legacy.limitId, legacy.model],
        set: {
          currentUsageTokensIn: sql`${legacy.currentUsageTokensIn} + excluded.current_usage_tokens_in`,
          currentUsageTokensOut: sql`${legacy.currentUsageTokensOut} + excluded.current_usage_tokens_out`,
          updatedAt: new Date(),
        },
      });
    const settled = schema.limitBillingUsageTable;
    await tx
      .insert(settled)
      .values(settledRows)
      .onConflictDoUpdate({
        target: [settled.limitId, settled.model],
        set: {
          coveredTokensIn: sql`${settled.coveredTokensIn} + excluded.covered_tokens_in`,
          coveredTokensOut: sql`${settled.coveredTokensOut} + excluded.covered_tokens_out`,
          cost: sql`${settled.cost} + excluded.cost`,
          incomplete: sql`${settled.incomplete} + excluded.incomplete`,
        },
      });
  }

  static async cleanupLimitsIfNeeded(
    options: LimitsCleanupOptions,
  ): Promise<void> {
    try {
      logger.debug({ options }, `[LimitsCleanup] Starting cleanup check`);

      const limitIdsToReset = await LimitModel.findLimitIdsToReset(options);
      await LimitModel.resetLimitsUsage(limitIdsToReset);

      if (limitIdsToReset.length > 0) {
        logger.info(
          { options, cleanedLimitIds: limitIdsToReset },
          `[LimitsCleanup] Completed cleanup of ${limitIdsToReset.length} limits`,
        );
      } else {
        logger.debug({ options }, `[LimitsCleanup] No limits need cleanup`);
      }
    } catch (error) {
      logger.error(
        { error, options },
        `[LimitsCleanup] Error cleaning up limits`,
      );
      // Don't throw - cleanup is best effort and shouldn't break the main flow
    }
  }

  static async findLimitIdsToReset(
    options: LimitsCleanupOptions,
  ): Promise<string[]> {
    if (
      options.entities !== undefined &&
      options.entityType === undefined &&
      options.entityId === undefined &&
      options.limitType === undefined &&
      options.allForOrganizationId === undefined
    ) {
      const parameters = limitEntityParameters(options.entities);
      if (!Object.values(parameters).some((ids) => ids.length > 0)) return [];
      const rows = await LimitModel.dueByEntities.get().execute(parameters);
      return rows.map((row) => row.id);
    }
    const filterConditions: SQL[] = [];
    if (options.entityType !== undefined) {
      filterConditions.push(
        eq(schema.limitsTable.entityType, options.entityType) as SQL,
      );
    }
    if (options.entityId !== undefined) {
      filterConditions.push(
        eq(schema.limitsTable.entityId, options.entityId) as SQL,
      );
    }
    if (options.limitType !== undefined) {
      filterConditions.push(
        eq(schema.limitsTable.limitType, options.limitType) as SQL,
      );
    }

    const entityIdConditions: SQL[] = [];
    const entities = options.entities;
    if (entities !== undefined) {
      const entityTypes = Object.getOwnPropertyNames(
        entities,
      ) as LimitEntityType[];
      entityTypes.forEach((entityType) => {
        const entityIds = entities[entityType];
        if (entityIds !== undefined) {
          entityIdConditions.push(
            and(
              eq(schema.limitsTable.entityType, entityType),
              Array.isArray(entityIds)
                ? inArray(schema.limitsTable.entityId, entityIds)
                : eq(schema.limitsTable.entityId, entityIds),
            ) as SQL,
          );
        }
      });
    }

    const selectionConditions: SQL[] = [];

    if (filterConditions.length > 0) {
      selectionConditions.push(and(...filterConditions) as SQL);
    }
    if (entityIdConditions.length > 0) {
      selectionConditions.push(or(...entityIdConditions) as SQL);
    }

    const scopeConditions: SQL[] = [];
    if (options.allForOrganizationId !== undefined) {
      scopeConditions.push(
        buildOrganizationLimitScopeCondition(options.allForOrganizationId),
      );
    }
    if (selectionConditions.length > 0) {
      scopeConditions.push(or(...selectionConditions) as SQL);
    }

    if (scopeConditions.length === 0) {
      return [];
    }

    const limitsToReset = await db
      .select({ id: schema.limitsTable.id })
      .from(schema.limitsTable)
      .where(
        and(
          ...scopeConditions,
          sql`${schema.limitsTable.limitType} NOT IN ('requests', 'tokens', 'requests_per_minute', 'tokens_per_minute')`,
          sql`${schema.limitsTable.cleanupInterval} <> 'minute'`,
          or(
            sql`${schema.limitsTable.lastCleanup} IS NULL`,
            buildCleanupDueCondition(),
          ),
        ),
      );

    return limitsToReset.map((l) => l.id);
  }

  /**
   * Reset usage counters for multiple limits at once
   * Sets lastCleanup and resets per-model usage records for token_cost limits
   * Important to run in transaction to mitigate partial reset of token_cost limits usage
   * Partial reset would block requests at least until the next scheduled reset attempt
   */
  static async resetLimitsUsage(
    limitIds: string[],
    now = new Date(),
  ): Promise<void> {
    if (limitIds.length === 0) {
      return;
    }

    // A usage row inserted after the locks below can still close a cycle
    // with a usage write, so a deadlocked reset reruns once from scratch.
    await retryOnceOnDeadlock(() =>
      withDbTransaction(async (tx) => {
        // Lock in the accumulator's order (limit id, then model) so a reset and
        // a concurrent usage write cannot deadlock.
        await tx
          .select({ id: schema.limitsTable.id })
          .from(schema.limitsTable)
          .where(inArray(schema.limitsTable.id, limitIds))
          .orderBy(schema.limitsTable.id)
          .for("no key update");
        const limits = await tx
          .update(schema.limitsTable)
          .set({ lastCleanup: now, updatedAt: now })
          .where(inArray(schema.limitsTable.id, limitIds))
          .returning({
            id: schema.limitsTable.id,
            limitType: schema.limitsTable.limitType,
          });

        const tokenCostLimitIds = limits
          .filter((l) => l.limitType === "token_cost")
          .map((l) => l.id);

        if (tokenCostLimitIds.length === 0) {
          return;
        }

        await tx
          .select({ id: schema.limitModelUsageTable.id })
          .from(schema.limitModelUsageTable)
          .where(
            inArray(schema.limitModelUsageTable.limitId, tokenCostLimitIds),
          )
          .orderBy(
            schema.limitModelUsageTable.limitId,
            schema.limitModelUsageTable.model,
          )
          .for("update");
        await tx
          .delete(schema.limitBillingUsageTable)
          .where(
            inArray(schema.limitBillingUsageTable.limitId, tokenCostLimitIds),
          );
        // Reset model usage records for token_cost limits
        await tx
          .update(schema.limitModelUsageTable)
          .set({
            currentUsageTokensIn: 0,
            currentUsageTokensOut: 0,
            updatedAt: now,
          })
          .where(
            inArray(schema.limitModelUsageTable.limitId, tokenCostLimitIds),
          );
      }),
    );
  }

  /**
   * Get limits for entity validation checks
   * Used by limit validation service to check if limits are exceeded
   */
  static async findLimitsForValidation(
    entityType: LimitEntityType,
    entityId: string,
    limitType: LimitType = "token_cost",
  ): Promise<Limit[]> {
    const limits = await db
      .select()
      .from(schema.limitsTable)
      .where(
        and(
          eq(schema.limitsTable.entityType, entityType),
          eq(schema.limitsTable.entityId, entityId),
          eq(schema.limitsTable.limitType, limitType),
        ),
      );

    return limits;
  }

  /**
   * Batched variant of {@link findLimitsForValidation}: fetch the limits for
   * many (entityType, entityId) pairs in a single query. Used by the LLM-proxy
   * pre-request check, which inspects limits across several entity levels
   * (virtual key, user, agent, environment, teams, organization) on every
   * request — issuing one query per level produced an N+1.
   */
  static async findLimitsForValidationForEntities(
    entities: { entityType: LimitEntityType; entityId: string }[],
    limitType: LimitType = "token_cost",
  ): Promise<Limit[]> {
    if (entities.length === 0) return [];
    const parameters = limitEntityParameters({});
    for (const { entityType, entityId } of entities)
      parameters[entityType].push(entityId);
    return LimitModel.validationByEntities
      .get()
      .execute({ ...parameters, limitType });
  }

  /** Read current budgets and any scoped counters needing cleanup together. */
  static async findProxyLimitState(
    entities: LimitsCleanupOptionsEntities,
    defaults: { organizationId: string | null; environmentId: string | null },
  ) {
    const rows = await LimitModel.proxyLimitState.get().execute({
      ...limitEntityParameters(entities),
      ...defaults,
    });
    return {
      limits: rows.flatMap(({ limit }) => (limit ? [limit] : [])),
      defaultUserLimit: rows[0]?.defaultUserLimit ?? null,
    };
  }

  // Org-scoped audit snapshot via the entity FK.  limitsTable has no
  // organizationId column of its own, so tenancy is resolved through the
  // entity that owns the limit (organization/team/agent/user/virtual_key).
  //
  // The route handler for PATCH/DELETE /api/limits/:id does not enforce this
  // predicate today, but the audit fetcher must — the preHandler runs before
  // route authz, so an unscoped fetch would write another tenant's limit row
  // into the caller's audit_logs even when the route ultimately rejects the
  // request.  Returns null whenever the limit does not belong to the caller's
  // organization.
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const [row] = await db
      .select()
      .from(schema.limitsTable)
      .where(eq(schema.limitsTable.id, id))
      .limit(1);

    if (!row) return null;

    const inOrg = await LimitModel.isEntityInOrganization(
      row.entityType,
      row.entityId,
      organizationId,
    );
    if (!inOrg) return null;

    return {
      id: row.id,
      entityType: row.entityType,
      entityId: row.entityId,
      limitType: row.limitType,
      limitValue: row.limitValue,
      mcpServerName: row.mcpServerName ?? null,
      toolName: row.toolName ?? null,
      model: row.model ?? null,
      cleanupInterval: row.cleanupInterval ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // Org-scoped fetch for PATCH/DELETE authorization.  limitsTable has no
  // organizationId column, so tenancy is resolved through the entity that owns
  // the limit.  Returns null when the limit does not belong to the caller's
  // organization (treated as 404 by routes).
  static async findByIdInOrganization(
    id: string,
    organizationId: string,
  ): Promise<LimitWithLabels | null> {
    const limit = await LimitModel.findById(id);
    if (!limit) return null;

    const inOrg = await LimitModel.isEntityInOrganization(
      limit.entityType,
      limit.entityId,
      organizationId,
    );
    if (!inOrg) return null;

    return { ...limit, labels: await LimitLabelModel.getLabelsFor(id) };
  }

  /**
   * Verify that a limit's entity (the row identified by `entityType` and
   * `entityId`) belongs to `organizationId`.  Each entity type lives in a
   * different table, so the FK path differs per branch.  Used by the
   * snapshot-before-authz scope predicate in `findByIdForAudit`, by the
   * org-scoping guards on create/update/delete routes, and by
   * `findByIdInOrganization`.
   */
  static async isEntityInOrganization(
    entityType: LimitEntityType,
    entityId: string,
    organizationId: string,
  ): Promise<boolean> {
    switch (entityType) {
      case "organization":
        return entityId === organizationId;
      case "team": {
        const [hit] = await db
          .select({ id: schema.teamsTable.id })
          .from(schema.teamsTable)
          .where(
            and(
              eq(schema.teamsTable.id, entityId),
              eq(schema.teamsTable.organizationId, organizationId),
            ),
          )
          .limit(1);
        return Boolean(hit);
      }
      case "agent": {
        return AgentModel.existsInOrganization({
          id: entityId,
          organizationId,
        });
      }
      case "user": {
        const [hit] = await db
          .select({ id: schema.membersTable.id })
          .from(schema.membersTable)
          .where(
            and(
              eq(schema.membersTable.userId, entityId),
              eq(schema.membersTable.organizationId, organizationId),
            ),
          )
          .limit(1);
        return Boolean(hit);
      }
      case "virtual_key": {
        const [hit] = await db
          .select({ id: schema.virtualApiKeysTable.id })
          .from(schema.virtualApiKeysTable)
          .where(
            and(
              eq(schema.virtualApiKeysTable.id, entityId),
              eq(schema.virtualApiKeysTable.organizationId, organizationId),
            ),
          )
          .limit(1);
        return Boolean(hit);
      }
      case "environment": {
        const [hit] = await db
          .select({ id: schema.environmentsTable.id })
          .from(schema.environmentsTable)
          .where(
            and(
              eq(schema.environmentsTable.id, entityId),
              eq(schema.environmentsTable.organizationId, organizationId),
            ),
          )
          .limit(1);
        return Boolean(hit);
      }
      case "llm_oauth_client": {
        const [hit] = await db
          .select({ id: schema.oauthClientsTable.id })
          .from(schema.oauthClientsTable)
          .where(
            and(
              eq(schema.oauthClientsTable.id, entityId),
              llmOauthClientInOrganization(organizationId),
            ),
          )
          .limit(1);
        return Boolean(hit);
      }
    }
  }

  /**
   * A limit reached through several entity refs accrues once per ref. Rows are
   * written in limit id order so concurrent statements lock them in the same
   * order as {@link resetLimitsUsage}. A deadlock aborts the statement before
   * any row is written, so it is retried once.
   */
  private static async addTokenUsage(params: {
    entityRefs: SQL;
    model: string;
    inputTokens: number;
    outputTokens: number;
    tx?: Transaction;
  }): Promise<void> {
    const { entityRefs, model, inputTokens, outputTokens, tx } = params;
    const limits = schema.limitsTable;
    const usage = schema.limitModelUsageTable;
    const statement = sql`
      WITH entity_refs (entity_type, entity_id) AS (${entityRefs}),
      matched AS (
        SELECT ${limits.id} AS limit_id, count(*)::integer AS refs
        FROM ${limits}
        JOIN entity_refs
          ON ${limits.entityType} = entity_refs.entity_type
          AND ${limits.entityId} = entity_refs.entity_id
        WHERE ${limits.limitType} = ${"token_cost"}
          AND ${limits.cleanupInterval} <> 'minute'
          AND (${limits.model} ? ${model} OR ${limits.model} IS NULL)
        GROUP BY ${limits.id}
      )
      INSERT INTO ${usage} (limit_id, model, current_usage_tokens_in, current_usage_tokens_out)
      SELECT limit_id, ${model}, refs * ${inputTokens}::bigint, refs * ${outputTokens}::bigint
      FROM matched
      ORDER BY limit_id
      ON CONFLICT (limit_id, model) DO UPDATE SET
        current_usage_tokens_in = ${usage}.current_usage_tokens_in + EXCLUDED.current_usage_tokens_in,
        current_usage_tokens_out = ${usage}.current_usage_tokens_out + EXCLUDED.current_usage_tokens_out,
        updated_at = ${sql.param(new Date(), usage.updatedAt)}
    `;
    if (tx) await tx.execute(statement);
    else await retryOnceOnDeadlock(() => db.execute(statement));
  }
  private static readonly dueByEntities = new PreparedQuery((database) =>
    database
      .select({ id: schema.limitsTable.id })
      .from(schema.limitsTable)
      .where(and(limitEntitiesCondition(), scopedCleanupDueCondition()))
      .prepare("archestra_due_limits_by_entities"),
  );

  private static readonly proxyLimitState = new PreparedQuery((database) => {
    const defaults = schema.environmentDefaultUserLimitsTable;
    // At most one environment override, otherwise the organization's global
    // default. A left join keeps the result even when no entity limit exists.
    const defaultUserLimit = database
      .select()
      .from(defaults)
      .where(
        and(
          eq(defaults.organizationId, sql.placeholder("organizationId")),
          or(
            eq(defaults.environmentId, sql.placeholder("environmentId")),
            isNull(defaults.environmentId),
          ),
        ),
      )
      .orderBy(sql`${defaults.environmentId} NULLS LAST`)
      .limit(1)
      .as("proxy_default_user_limit");
    return database
      .select({
        limit: {
          ...getTableColumns(schema.limitsTable),
          cleanupDue: scopedCleanupDueCondition(),
        },
        defaultUserLimit: {
          id: defaultUserLimit.id,
          organizationId: defaultUserLimit.organizationId,
          environmentId: defaultUserLimit.environmentId,
          limitValue: defaultUserLimit.limitValue,
          model: defaultUserLimit.model,
          cleanupInterval: defaultUserLimit.cleanupInterval,
          createdAt: defaultUserLimit.createdAt,
          updatedAt: defaultUserLimit.updatedAt,
        },
      })
      .from(sql`(VALUES (1)) AS proxy_limit_context(present)`)
      .leftJoin(
        schema.limitsTable,
        and(
          limitEntitiesCondition(),
          or(
            eq(schema.limitsTable.limitType, "token_cost"),
            scopedCleanupDueCondition(),
          ),
        ),
      )
      .leftJoin(defaultUserLimit, sql`true`)
      .prepare("archestra_proxy_limit_state");
  });
  private static readonly validationByEntities = new PreparedQuery((database) =>
    database
      .select()
      .from(schema.limitsTable)
      .where(
        and(
          eq(schema.limitsTable.limitType, sql.placeholder("limitType")),
          limitEntitiesCondition(),
        ),
      )
      .prepare("archestra_validation_limits_by_entities"),
  );
}

/**
 * Service for validating if current usage has exceeded token cost limits
 */
export class LimitValidationService {
  /**
   * Check if current usage has already exceeded any token cost limits
   * Returns null if allowed, or a refusal tuple if blocked.
   */
  static async checkLimitsBeforeRequest(params: {
    /** Refuse applicable budgets when this media model cannot be priced. */
    unpricedMediaModel?: string;
    agentId: string;
    userId?: string;
    virtualKeyId?: string;
    passthroughVirtualKeyId?: string;
    /** The agent row this request already read. */
    agent?: { environmentId: string | null; organizationId?: string };
    teamSource?: AgentTeamSource;
    /** Fresh rows from this request's scoped metadata query. */
    snapshot?: Pick<ProxyRequestState, "scope" | "agentTeamIds" | "limitState">;
    /** LLM OAuth client the request authenticated as, for its spend cap. */
    llmOauthClientId?: string;
    /**
     * Team the calling credential is billed to. It replaces the agent's teams
     * for team limits, and the caller's personal and default user limits do
     * not apply: the team pays.
     */
    billingTeamId?: string;
  }): Promise<null | LimitViolationResponse> {
    const { agentId, virtualKeyId, passthroughVirtualKeyId, llmOauthClientId } =
      params;
    const userId = params.billingTeamId ? undefined : params.userId;

    try {
      logger.debug(
        `[LimitValidation] Starting limit check for agent: ${agentId}`,
      );

      const scope = params.snapshot?.scope;
      const snapshot =
        scope &&
        params.agent?.organizationId === scope.organizationId &&
        params.agent?.environmentId === scope.environmentId &&
        scope.agentId === agentId &&
        scope.userId === params.userId &&
        scope.billingTeamId === params.billingTeamId &&
        scope.virtualKeyId === virtualKeyId &&
        scope.passthroughVirtualKeyId === passthroughVirtualKeyId &&
        scope.llmOauthClientId === llmOauthClientId
          ? params.snapshot
          : undefined;

      // Get the teams to cleanup and check team and organization limits: the
      // credential's billing team when it has one, otherwise the agent's teams.
      const agentTeamIds = params.billingTeamId
        ? [params.billingTeamId]
        : (snapshot?.agentTeamIds ??
          (params.teamSource
            ? await params.teamSource.agentTeamIds(agentId)
            : await AgentTeamModel.getTeamsForAgent(agentId)));
      logger.debug(
        `[LimitValidation] Agent ${agentId} belongs to teams: ${agentTeamIds.join(", ")}`,
      );

      // The proxy already resolved this agent and its team IDs. Reuse that
      // request-local attribution rather than hydrating the same teams again.
      let organizationId: string | null = params.agent?.organizationId ?? null;
      let agentTeams: { id: string; organizationId: string }[] = [];
      if (organizationId) {
        const resolvedOrganizationId = organizationId;
        agentTeams = agentTeamIds.map((id) => ({
          id,
          organizationId: resolvedOrganizationId,
        }));
      } else if (agentTeamIds.length > 0) {
        agentTeams = await db
          .select()
          .from(schema.teamsTable)
          .where(inArray(schema.teamsTable.id, agentTeamIds));
        if (agentTeams.length > 0 && agentTeams[0].organizationId) {
          organizationId = agentTeams[0].organizationId;
        }
      } else {
        organizationId =
          params.agent?.organizationId ??
          (await AgentModel.findOrganizationId(agentId));
      }

      // Resolve the agent's environment (nullable). Used for environment-scoped
      // limits and per-environment default-user limits.
      const environmentId = params.agent
        ? params.agent.environmentId
        : await AgentModel.findEnvironmentId(agentId);

      const entities: LimitsCleanupOptionsEntities = {
        agent: agentId,
      };
      const virtualKeyIds = [virtualKeyId, passthroughVirtualKeyId].filter(
        (id): id is string => Boolean(id),
      );
      if (virtualKeyIds.length > 0) {
        entities.virtual_key = virtualKeyIds;
      }
      if (llmOauthClientId) {
        entities.llm_oauth_client = llmOauthClientId;
      }
      if (userId) {
        entities.user = userId;
      }
      if (agentTeamIds.length > 0) {
        entities.team = agentTeamIds;
      }
      if (organizationId) {
        entities.organization = organizationId;
      }
      if (environmentId) {
        entities.environment = environmentId;
      }

      // Prefetch every limit, per-model usage row, and model price the priority
      // checks below may need, in a fixed set of batched queries. Each entity
      // level used to issue its own limit_model_usage + models lookups, which
      // showed up as an N+1 on LLM-proxy requests. Built AFTER cleanup so the
      // usage rows reflect any windows that were just reset.
      const entitiesToCheck: {
        entityType: LimitEntityType;
        entityId: string;
      }[] = [];
      if (passthroughVirtualKeyId) {
        entitiesToCheck.push({
          entityType: "virtual_key",
          entityId: passthroughVirtualKeyId,
        });
      }
      if (virtualKeyId) {
        entitiesToCheck.push({
          entityType: "virtual_key",
          entityId: virtualKeyId,
        });
      }
      if (llmOauthClientId) {
        entitiesToCheck.push({
          entityType: "llm_oauth_client",
          entityId: llmOauthClientId,
        });
      }
      if (userId) {
        entitiesToCheck.push({ entityType: "user", entityId: userId });
      }
      entitiesToCheck.push({ entityType: "agent", entityId: agentId });
      if (environmentId) {
        entitiesToCheck.push({
          entityType: "environment",
          entityId: environmentId,
        });
      }
      for (const team of agentTeams) {
        entitiesToCheck.push({ entityType: "team", entityId: team.id });
      }
      if (organizationId) {
        entitiesToCheck.push({
          entityType: "organization",
          entityId: organizationId,
        });
      }
      let { limits: scopedLimits, defaultUserLimit } =
        snapshot?.limitState ??
        (await LimitModel.findProxyLimitState(entities, {
          organizationId,
          environmentId,
        }));
      if (scopedLimits.some((limit) => limit.cleanupDue)) {
        await LimitModel.cleanupLimitsIfNeeded({ entities });
        // Cleanup changes usage: validation must read its committed result.
        ({ limits: scopedLimits, defaultUserLimit } =
          await LimitModel.findProxyLimitState(entities, {
            organizationId,
            environmentId,
          }));
      }
      const checkedEntities = new Set(
        entitiesToCheck.map(
          ({ entityType, entityId }) => `${entityType}:${entityId}`,
        ),
      );
      const limits = scopedLimits
        .filter(
          (limit) =>
            limit.limitType === "token_cost" &&
            checkedEntities.has(`${limit.entityType}:${limit.entityId}`),
        )
        .map(({ cleanupDue: _cleanupDue, ...limit }) => limit);
      const prefetch = await LimitValidationService.prefetchEntityLimits(
        entitiesToCheck,
        limits,
      );

      if (params.unpricedMediaModel) {
        const applies = (models?: string[] | null) =>
          !models?.length || models.includes(params.unpricedMediaModel ?? "");
        const limits = [...prefetch.limitsByEntity.values()].flat();
        let budgeted = limits.some((limit) => applies(limit.model));
        const customUserLimits = userId
          ? prefetch.limitsByEntity.get(`user:${userId}`)
          : undefined;
        if (userId && organizationId && !customUserLimits?.length) {
          const defaultLimit = defaultUserLimit;
          budgeted ||= !!defaultLimit && applies(defaultLimit.model);
        }
        if (budgeted)
          throw new ApiError(
            422,
            "This media operation cannot satisfy the configured budget because authoritative cost is unavailable",
          );
      }

      // The passthrough key is the user-bound cost-bearing identity, so its
      // per-key limit is checked first and takes precedence over the standard
      // virtual key when both are present on the request.
      if (passthroughVirtualKeyId) {
        const passthroughLimitViolation =
          LimitValidationService.evaluateEntityLimits(
            "virtual_key",
            passthroughVirtualKeyId,
            prefetch,
          );
        if (passthroughLimitViolation) {
          logger.info(
            `[LimitValidation] BLOCKED by passthrough virtual-key-level limit for: ${passthroughVirtualKeyId}`,
          );
          return passthroughLimitViolation;
        }
      }

      if (virtualKeyId) {
        logger.debug(
          `[LimitValidation] Checking virtual-key-level limits for: ${virtualKeyId}`,
        );
        const vkLimitViolation = LimitValidationService.evaluateEntityLimits(
          "virtual_key",
          virtualKeyId,
          prefetch,
        );
        if (vkLimitViolation) {
          logger.info(
            `[LimitValidation] BLOCKED by virtual-key-level limit for: ${virtualKeyId}`,
          );
          return vkLimitViolation;
        }
        logger.debug(
          `[LimitValidation] Virtual-key-level limits OK for: ${virtualKeyId}`,
        );
      }

      if (llmOauthClientId) {
        const clientLimitViolation =
          LimitValidationService.evaluateEntityLimits(
            "llm_oauth_client",
            llmOauthClientId,
            prefetch,
          );
        if (clientLimitViolation) {
          logger.info(
            `[LimitValidation] BLOCKED by OAuth-client-level limit for: ${llmOauthClientId}`,
          );
          return clientLimitViolation;
        }
      }

      if (userId) {
        logger.debug(
          `[LimitValidation] Checking user-level limits for: ${userId}`,
        );
        const userLimitViolation = LimitValidationService.evaluateEntityLimits(
          "user",
          userId,
          prefetch,
        );
        if (userLimitViolation) {
          logger.info(
            `[LimitValidation] BLOCKED by user-level limit for: ${userId}`,
          );
          return userLimitViolation;
        }
        if (organizationId) {
          const defaultUserLimitViolation =
            await LimitValidationService.checkDefaultUserLimit({
              organizationId,
              userId,
              environmentId,
              customUserLimits:
                prefetch.limitsByEntity.get(`user:${userId}`) ?? [],
              defaultLimit: defaultUserLimit,
            });
          if (defaultUserLimitViolation) {
            logger.info(
              `[LimitValidation] BLOCKED by default user limit for: ${userId}`,
            );
            return defaultUserLimitViolation;
          }
        }
        logger.debug(`[LimitValidation] User-level limits OK for: ${userId}`);
      }

      logger.debug(
        `[LimitValidation] Checking agent-level limits for: ${agentId}`,
      );
      const agentLimitViolation = LimitValidationService.evaluateEntityLimits(
        "agent",
        agentId,
        prefetch,
      );
      if (agentLimitViolation) {
        logger.info(
          `[LimitValidation] BLOCKED by agent-level limit for: ${agentId}`,
        );
        return agentLimitViolation;
      }
      logger.debug(`[LimitValidation] Agent-level limits OK for: ${agentId}`);

      // Check environment-level limits (total usage across all users in the
      // agent's environment).
      if (environmentId) {
        logger.debug(
          `[LimitValidation] Checking environment-level limits for: ${environmentId}`,
        );
        const environmentLimitViolation =
          LimitValidationService.evaluateEntityLimits(
            "environment",
            environmentId,
            prefetch,
          );
        if (environmentLimitViolation) {
          logger.info(
            `[LimitValidation] BLOCKED by environment-level limit for: ${environmentId}`,
          );
          return environmentLimitViolation;
        }
        logger.debug(
          `[LimitValidation] Environment-level limits OK for: ${environmentId}`,
        );
      }

      // Check team-level limits
      if (agentTeamIds.length > 0) {
        logger.debug(
          `[LimitValidation] Checking team-level limits for agent: ${agentId}`,
        );
        logger.debug(
          `[LimitValidation] Found ${agentTeams.length} teams for agent ${agentId}: ${agentTeams.map((t) => `${t.id}(org:${t.organizationId})`).join(", ")}`,
        );

        for (const team of agentTeams) {
          logger.debug(
            `[LimitValidation] Checking team limit for team: ${team.id}`,
          );
          const teamLimitViolation =
            LimitValidationService.evaluateEntityLimits(
              "team",
              team.id,
              prefetch,
            );
          if (teamLimitViolation) {
            logger.info(
              `[LimitValidation] BLOCKED by team-level limit for team: ${team.id}`,
            );
            return teamLimitViolation;
          }
          logger.debug(
            `[LimitValidation] Team-level limits OK for team: ${team.id}`,
          );
        }
      }

      // Check organization-level limits for any agent with a resolvable org.
      if (organizationId) {
        logger.debug(
          `[LimitValidation] Checking organization-level limits for org: ${organizationId}`,
        );
        const orgLimitViolation = LimitValidationService.evaluateEntityLimits(
          "organization",
          organizationId,
          prefetch,
        );
        if (orgLimitViolation) {
          logger.info(
            `[LimitValidation] BLOCKED by organization-level limit for org: ${organizationId}`,
          );
          return orgLimitViolation;
        }
        logger.debug(
          `[LimitValidation] Organization-level limits OK for org: ${organizationId}`,
        );
      }

      logger.debug(
        `[LimitValidation] All limits OK for agent: ${agentId} - ALLOWING request`,
      );
      return null; // No limits exceeded
    } catch (error) {
      logger.error(
        `[LimitValidation] Error checking limits before request: ${error}`,
      );
      if (
        config.llmProxy.usageAccountingMode === "enforce" ||
        params.unpricedMediaModel
      )
        throw error;
      return null;
    }
  }

  /**
   * Batch-load the limits, per-model usage rows, and model prices needed to
   * evaluate token_cost limits for a set of entities. Collapses what used to be
   * a per-entity/per-limit set of queries into three queries total.
   */
  private static async prefetchEntityLimits(
    entities: { entityType: LimitEntityType; entityId: string }[],
    currentLimits?: Limit[],
  ): Promise<LimitPrefetch> {
    const limits =
      currentLimits ??
      (await LimitModel.findLimitsForValidationForEntities(
        entities,
        "token_cost",
      ));

    const limitsByEntity = new Map<string, Limit[]>();
    for (const limit of limits) {
      // Minute spend is actual-cost accounting in the shared continuous bucket.
      if (limit.cleanupInterval === "minute") continue;
      const key = `${limit.entityType}:${limit.entityId}`;
      const existing = limitsByEntity.get(key);
      if (existing) existing.push(limit);
      else limitsByEntity.set(key, [limit]);
    }

    const usageByLimitId = new Map<string, LimitModelUsageRecord[]>();
    if (limits.length > 0) {
      const usageRows = await db
        .select(usageSelection)
        .from(schema.limitModelUsageTable)
        .leftJoin(schema.limitBillingUsageTable, billingJoin)
        .where(
          inArray(
            schema.limitModelUsageTable.limitId,
            limits.map((limit) => limit.id),
          ),
        );
      for (const row of usageRows) {
        const existing = usageByLimitId.get(row.limitId);
        if (existing) existing.push(row);
        else usageByLimitId.set(row.limitId, [row]);
      }
    }

    const modelIds = new Set<string>();
    for (const rows of usageByLimitId.values()) {
      for (const row of rows) modelIds.add(row.model);
    }
    const pricingByModelId = await ModelModel.findByModelIdsOnly(
      Array.from(modelIds),
    );

    return { limitsByEntity, usageByLimitId, pricingByModelId };
  }

  /**
   * Check if current token cost usage has exceeded limits for a specific entity,
   * using data already loaded by {@link prefetchEntityLimits}. Pure in-memory
   * evaluation — issues no queries of its own.
   */
  private static evaluateEntityLimits(
    entityType: LimitEntityType,
    entityId: string,
    prefetch: LimitPrefetch,
  ): null | LimitViolationResponse {
    const limits =
      prefetch.limitsByEntity.get(`${entityType}:${entityId}`) ?? [];

    if (limits.length === 0) {
      logger.debug(
        `[LimitValidation] No token_cost limits found for ${entityType} ${entityId} - allowing`,
      );
      return null;
    }

    for (const limit of limits) {
      logger.debug(
        `[LimitValidation] Checking limit ${limit.id} for ${entityType} ${entityId}`,
      );

      // For token_cost limits, convert tokens to actual cost using token prices
      let comparisonValue = 0;
      let limitDescription: "tokens" | "cost_dollars" = "tokens";
      let totalTokensIn = 0;
      let totalTokensOut = 0;

      if (limit.limitType === "token_cost") {
        const modelUsages = prefetch.usageByLimitId.get(limit.id) ?? [];

        if (modelUsages.length === 0) {
          logger.warn(
            `[LimitValidation] No model usage records found for limit ${limit.id}`,
          );
        } else {
          const usageCosts = computeModelUsageCosts(
            modelUsages,
            prefetch.pricingByModelId,
          );

          totalTokensIn = usageCosts.tokensIn;
          totalTokensOut = usageCosts.tokensOut;
          comparisonValue = usageCosts.incomplete
            ? Number.POSITIVE_INFINITY
            : usageCosts.cost;
          limitDescription = "cost_dollars";

          logger.debug(
            `[LimitValidation] Total cost for limit ${limit.id}: $${usageCosts.cost.toFixed(2)} across ${modelUsages.length} models`,
          );
        }
      }

      if (comparisonValue >= limit.limitValue) {
        logger.info(
          `[LimitValidation] LIMIT EXCEEDED for ${entityType} ${entityId}: ${comparisonValue} ${limitDescription} >= ${limit.limitValue}`,
        );

        return buildLimitViolationResponse({
          entityType,
          entityId,
          limitValue: limit.limitValue,
          comparisonValue,
          limitDescription,
          totalTokensIn,
          totalTokensOut,
          cleanupInterval: limit.cleanupInterval,
          models: limit.model,
        });
      }

      logger.debug(
        `[LimitValidation] Limit OK for ${entityType} ${entityId}: ${comparisonValue} < ${limit.limitValue}`,
      );
    }

    logger.debug(
      `[LimitValidation] All ${limits.length} limits OK for ${entityType} ${entityId}`,
    );
    return null; // No limits exceeded for this entity
  }

  private static async checkDefaultUserLimit(params: {
    organizationId: string;
    userId: string;
    environmentId?: string | null;
    customUserLimits?: Limit[];
    /** Fresh default read with this request's entity limits; null means none. */
    defaultLimit?: EnvironmentDefaultUserLimit | null;
  }): Promise<null | LimitViolationResponse> {
    try {
      // A custom per-user limit always wins and disables every default
      // (org-wide and per-environment) for that user.
      const customUserLimits =
        params.customUserLimits ??
        (await LimitModel.findLimitsForValidation(
          "user",
          params.userId,
          "token_cost",
        ));
      if (customUserLimits.length > 0) {
        logger.debug(
          `[LimitValidation] Skipping default user limit for ${params.userId}: custom user limit exists`,
        );
        return null;
      }

      const defaultLimit =
        params.defaultLimit !== undefined
          ? params.defaultLimit
          : ((params.environmentId
              ? await EnvironmentDefaultUserLimitModel.findByEnvironmentId(
                  params.environmentId,
                )
              : null) ??
            (await EnvironmentDefaultUserLimitModel.findGlobal(
              params.organizationId,
            )));
      if (!defaultLimit) return null;
      // An override counts only this environment; the global fallback counts
      // the user's whole organization, preserving custom-user precedence.
      const environmentId = defaultLimit.environmentId;
      const usage = await getDefaultUserLimitUsage({
        organizationId: params.organizationId,
        userId: params.userId,
        ...(environmentId ? { environmentId } : {}),
        models: normalizeLimitModels(defaultLimit.model),
        cleanupInterval: defaultLimit.cleanupInterval,
      });
      if (usage.cost < defaultLimit.limitValue) return null;
      return buildLimitViolationResponse({
        entityType: environmentId ? "environment" : "user",
        entityId: environmentId ?? params.userId,
        limitValue: defaultLimit.limitValue,
        comparisonValue: usage.cost,
        limitDescription: "cost_dollars",
        totalTokensIn: usage.tokensIn,
        totalTokensOut: usage.tokensOut,
        cleanupInterval: defaultLimit.cleanupInterval,
        models: defaultLimit.model,
      });
    } catch (error) {
      logger.error(
        { error, params },
        "[LimitValidation] Error checking default user limit",
      );
      if (config.llmProxy.usageAccountingMode === "enforce") throw error;
      return null;
    }
  }
}

const calendarCleanupIntervals = [
  "calendar_day",
  "calendar_week_sunday",
  "calendar_week_monday",
  "calendar_month",
] as const satisfies readonly LimitCleanupInterval[];

type CalendarLimitCleanupInterval = (typeof calendarCleanupIntervals)[number];

/**
 * Rows visible to an organization. `limits` has no organization column: a limit
 * is scoped by the entity it targets, so membership is proven per entity type.
 *
 * @public — also used by the limit label model to scope its label vocabulary.
 */
export function buildOrganizationLimitScopeCondition(
  organizationId: string,
): SQL {
  return or(
    and(
      eq(schema.limitsTable.entityType, "organization"),
      eq(schema.limitsTable.entityId, organizationId),
    ),
    and(
      eq(schema.limitsTable.entityType, "team"),
      sql`EXISTS (
        SELECT 1 FROM ${schema.teamsTable}
        WHERE ${schema.teamsTable.id} = ${schema.limitsTable.entityId}
          AND ${schema.teamsTable.organizationId} = ${organizationId}
      )`,
    ),
    and(
      eq(schema.limitsTable.entityType, "agent"),
      sql`EXISTS (
        SELECT 1 FROM ${schema.agentsTable}
        WHERE ${schema.agentsTable.id}::text = ${schema.limitsTable.entityId}
          AND ${schema.agentsTable.organizationId} = ${organizationId}
          AND ${schema.agentsTable.deletedAt} IS NULL
      )`,
    ),
    and(
      eq(schema.limitsTable.entityType, "user"),
      sql`EXISTS (
        SELECT 1 FROM ${schema.membersTable}
        WHERE ${schema.membersTable.userId} = ${schema.limitsTable.entityId}
          AND ${schema.membersTable.organizationId} = ${organizationId}
      )`,
    ),
    and(
      eq(schema.limitsTable.entityType, "virtual_key"),
      sql`EXISTS (
        SELECT 1 FROM ${schema.virtualApiKeysTable}
        WHERE ${schema.virtualApiKeysTable.id}::text = ${schema.limitsTable.entityId}
          AND ${schema.virtualApiKeysTable.organizationId} = ${organizationId}
      )`,
    ),
    and(
      eq(schema.limitsTable.entityType, "environment"),
      sql`EXISTS (
        SELECT 1 FROM ${schema.environmentsTable}
        WHERE ${schema.environmentsTable.id}::text = ${schema.limitsTable.entityId}
          AND ${schema.environmentsTable.organizationId} = ${organizationId}
      )`,
    ),
    and(
      eq(schema.limitsTable.entityType, "llm_oauth_client"),
      sql`EXISTS (
        SELECT 1 FROM ${schema.oauthClientsTable}
        WHERE ${schema.oauthClientsTable.id} = ${schema.limitsTable.entityId}
          AND ${llmOauthClientInOrganization(organizationId)}
      )`,
    ),
  ) as SQL;
}

/** LLM OAuth clients live in the shared `oauth_client` table, scoped by metadata. */
function llmOauthClientInOrganization(organizationId: string): SQL {
  return sql`(${schema.oauthClientsTable.metadata}->>'type' IN ('llm_oauth_client', 'managed_oauth_client')
    AND ${schema.oauthClientsTable.metadata}->>'organizationId' = ${organizationId})`;
}

export function scopedCleanupDueCondition(): SQL<boolean> {
  return and(
    sql`${schema.limitsTable.limitType} NOT IN ('requests', 'tokens', 'requests_per_minute', 'tokens_per_minute')`,
    sql`${schema.limitsTable.cleanupInterval} <> 'minute'`,
    or(isNull(schema.limitsTable.lastCleanup), buildCleanupDueCondition()),
  ) as SQL<boolean>;
}

function buildCleanupDueCondition(): SQL {
  const intervalConditions = Object.entries(
    LimitModel.rollingCleanupIntervalSqlLiterals,
  ).map(([cleanupInterval, sqlLiteral]) =>
    and(
      eq(
        schema.limitsTable.cleanupInterval,
        cleanupInterval as LimitCleanupInterval,
      ),
      lt(schema.limitsTable.lastCleanup, sql`now() - ${sqlLiteral}::interval`),
    ),
  );

  intervalConditions.push(
    ...calendarCleanupIntervals.map((cleanupInterval) =>
      and(
        eq(schema.limitsTable.cleanupInterval, cleanupInterval),
        lt(
          schema.limitsTable.lastCleanup,
          getCalendarPeriodStartSql(cleanupInterval),
        ),
      ),
    ),
  );

  return or(...intervalConditions) as SQL;
}

function buildUsagePeriodStartCondition(
  cleanupInterval: LimitCleanupInterval,
  createdAt:
    | typeof schema.interactionsTable.createdAt
    | typeof schema.interactionBillingTable.createdAt = schema.interactionsTable
    .createdAt,
): SQL {
  const rollingInterval =
    LimitModel.rollingCleanupIntervalSqlLiterals[
      cleanupInterval as RollingLimitCleanupInterval
    ];
  if (rollingInterval) {
    return sql`${createdAt} >= now() - ${rollingInterval}::interval`;
  }

  if (isCalendarCleanupInterval(cleanupInterval)) {
    return sql`${createdAt} >= ${getCalendarPeriodStartSql(cleanupInterval)}`;
  }

  throw new Error(`Unsupported cleanup interval: ${cleanupInterval}`);
}

function getCalendarPeriodStartSql(
  cleanupInterval: CalendarLimitCleanupInterval,
): SQL {
  switch (cleanupInterval) {
    case "calendar_day":
      return sql`date_trunc('day', now())`;
    case "calendar_week_sunday":
      return sql`date_trunc('day', now()) - (extract(dow from now()) * interval '1 day')`;
    case "calendar_week_monday":
      return sql`date_trunc('week', now())`;
    case "calendar_month":
      return sql`date_trunc('month', now())`;
  }
}

function isCalendarCleanupInterval(
  cleanupInterval: LimitCleanupInterval,
): cleanupInterval is CalendarLimitCleanupInterval {
  return calendarCleanupIntervals.includes(
    cleanupInterval as CalendarLimitCleanupInterval,
  );
}

// Pure cost computation from already-loaded pricing, so callers can share one
// batched price lookup across many limits.
function computeModelUsageCosts(
  modelUsages: LimitModelUsageRecord[],
  modelEntriesByModelId: Map<string, Model>,
) {
  let cost = "0.0000000000";
  let tokensIn = 0;
  let tokensOut = 0;
  let incomplete = false;
  const breakdown = modelUsages.map((usage) => {
    tokensIn += usage.currentUsageTokensIn;
    tokensOut += usage.currentUsageTokensOut;
    incomplete ||= (usage.incomplete ?? 0) > 0;
    const pricing = ModelModel.getEffectivePricing(
      modelEntriesByModelId.get(usage.model) ?? null,
      usage.model,
    );
    const legacyCost = priceTokens(
      {
        inputTokens: Math.max(
          0,
          usage.currentUsageTokensIn - (usage.coveredTokensIn ?? 0),
        ),
        outputTokens: Math.max(
          0,
          usage.currentUsageTokensOut - (usage.coveredTokensOut ?? 0),
        ),
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite1hTokens: 0,
      },
      {
        input: pricing.pricePerMillionInput,
        output: pricing.pricePerMillionOutput,
        cacheRead: null,
        cacheWrite: null,
        cacheWrite1h: null,
        source: pricing.source,
      },
    );
    const modelCost = sumMoney([legacyCost, usage.settledCost ?? "0"]);
    cost = sumMoney([cost, modelCost]);
    return {
      model: usage.model,
      tokensIn: usage.currentUsageTokensIn,
      tokensOut: usage.currentUsageTokensOut,
      cost: Number(modelCost),
    };
  });
  return { breakdown, cost: Number(cost), tokensIn, tokensOut, incomplete };
}

async function getDefaultUserLimitUsage(params: {
  organizationId: string;
  userId: string;
  models: string[] | null;
  cleanupInterval: LimitCleanupInterval;
  environmentId?: string | null;
}) {
  const conditions: SQL[] = [
    eq(schema.interactionsTable.userId, params.userId),
    // Subscription-billed traffic (e.g. Claude Pro/Max, ChatGPT Codex) costs
    // the organization $0 and must not burn down default user limits — the
    // same rule updateUsageAfterInteraction applies to explicit limits.
    eq(schema.interactionsTable.billingMode, "metered"),
    // Team-billed traffic is charged to the team, not to the caller.
    isNull(schema.interactionsTable.billingTeamId),
    buildUsagePeriodStartCondition(params.cleanupInterval),
    buildAfterUsageResetCondition({
      organizationId: params.organizationId,
      userId: sql`${params.userId}`,
      createdAt: schema.interactionsTable.createdAt,
    }),
    sql`NOT EXISTS (SELECT 1 FROM ${schema.interactionBillingTable} WHERE ${schema.interactionBillingTable.interactionId} = ${schema.interactionsTable.id} AND ${schema.interactionBillingTable.usage}->>'mode' = 'enforce')`,
  ];

  if (params.models && params.models.length > 0) {
    conditions.push(
      inArray(schema.interactionsTable.model, params.models) as SQL,
    );
  }

  const selection = {
    model: schema.interactionsTable.model,
    costUnavailable: sql<boolean>`${schema.interactionsTable.response}->'__mediaUsage'->>'costAvailable' = 'false'`,
    cost: schema.interactionsTable.cost,
    inputTokens: schema.interactionsTable.inputTokens,
    outputTokens: schema.interactionsTable.outputTokens,
  };

  // Environment-scoped usage filters on the environment snapshotted on the
  // interaction at request time. An environment belongs to exactly one org, so
  // this already scopes to the org without joining the agent — and, like the
  // incremental environment counter, it must count usage even after the
  // originating agent is deleted (no `notDeleted(agent)` join).
  const interactions = params.environmentId
    ? await db
        .select(selection)
        .from(schema.interactionsTable)
        .where(
          and(
            ...conditions,
            eq(schema.interactionsTable.environmentId, params.environmentId),
          ),
        )
    : await db
        .select(selection)
        .from(schema.interactionsTable)
        .innerJoin(
          schema.agentsTable,
          eq(schema.interactionsTable.profileId, schema.agentsTable.id),
        )
        .where(
          and(
            ...conditions,
            eq(schema.agentsTable.organizationId, params.organizationId),
            notDeleted(schema.agentsTable),
          ),
        );

  const modelsMissingCost = Array.from(
    new Set(
      interactions
        .filter(
          (interaction) =>
            interaction.cost === null &&
            interaction.model !== null &&
            !interaction.costUnavailable,
        )
        .map((interaction) => interaction.model as string),
    ),
  );
  const modelEntriesByModelId =
    await ModelModel.findByModelIdsOnly(modelsMissingCost);

  const receipt = schema.interactionBillingTable;
  const componentMatches = params.models?.length
    ? inArray(sql`component->>'model'`, params.models)
    : sql`true`;
  const [settled] = await db
    .select({
      cost: sql<string>`COALESCE(sum((component->>'cost')::numeric) FILTER (WHERE ${componentMatches}), 0)::text`,
      tokensIn: sql<number>`COALESCE(sum((component->>'inputTokens')::bigint) FILTER (WHERE ${componentMatches}), 0)::bigint`,
      tokensOut: sql<number>`COALESCE(sum((component->>'outputTokens')::bigint) FILTER (WHERE ${componentMatches}), 0)::bigint`,
      incomplete: sql<number>`count(*) FILTER (WHERE ${receipt.usage}->>'status' = 'incomplete')::integer`,
    })
    .from(receipt)
    .leftJoin(
      sql`LATERAL jsonb_array_elements(${receipt.usage}->'components') AS component`,
      sql`true`,
    )
    .where(
      and(
        eq(receipt.organizationId, params.organizationId),
        eq(receipt.userId, params.userId),
        eq(receipt.billingMode, "metered"),
        isNull(receipt.billingTeamId),
        sql`${receipt.usage}->>'mode' = 'enforce'`,
        buildUsagePeriodStartCondition(
          params.cleanupInterval,
          receipt.createdAt,
        ),
        buildAfterUsageResetCondition({
          organizationId: params.organizationId,
          userId: sql`${params.userId}`,
          createdAt: receipt.createdAt,
        }),
        params.environmentId
          ? eq(receipt.environmentId, params.environmentId)
          : undefined,
      ),
    );
  let cost = "0.0000000000";
  let tokensIn = 0;
  let tokensOut = 0;
  let unavailableMediaCost = false;
  for (const interaction of interactions) {
    if (interaction.costUnavailable) {
      unavailableMediaCost = true;
      continue;
    }
    const inputTokens = interaction.inputTokens ?? 0;
    const outputTokens = interaction.outputTokens ?? 0;
    tokensIn += inputTokens;
    tokensOut += outputTokens;

    if (interaction.cost !== null) {
      cost = sumMoney([cost, interaction.cost]);
      continue;
    }

    if (!interaction.model) {
      continue;
    }

    const modelEntry = modelEntriesByModelId.get(interaction.model) ?? null;
    const pricing = ModelModel.getEffectivePricing(
      modelEntry,
      interaction.model,
    );
    cost = sumMoney([
      cost,
      priceTokens(
        {
          inputTokens,
          outputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cacheWrite1hTokens: 0,
        },
        {
          input: pricing.pricePerMillionInput,
          output: pricing.pricePerMillionOutput,
          cacheRead: null,
          cacheWrite: null,
          cacheWrite1h: null,
          source: pricing.source,
        },
      ),
    ]);
  }
  tokensIn += Number(settled?.tokensIn ?? 0);
  tokensOut += Number(settled?.tokensOut ?? 0);
  cost = sumMoney([cost, settled?.cost ?? "0"]);
  return {
    cost:
      settled?.incomplete || unavailableMediaCost
        ? Number.POSITIVE_INFINITY
        : Number(cost),
    tokensIn,
    tokensOut,
  };
}

/**
 * Only spend after the user's last admin reset counts toward a default user
 * limit. A user who was never reset has no marker, so nothing is excluded.
 */
function buildAfterUsageResetCondition(params: {
  organizationId: string;
  userId:
    | SQL
    | typeof schema.interactionsTable.userId
    | typeof schema.interactionBillingTable.userId;
  createdAt:
    | typeof schema.interactionsTable.createdAt
    | typeof schema.interactionBillingTable.createdAt;
}): SQL {
  const resets = schema.userLimitUsageResetsTable;
  return sql`NOT EXISTS (SELECT 1 FROM ${resets} WHERE ${resets.organizationId} = ${params.organizationId} AND ${resets.userId} = ${params.userId} AND ${resets.resetAt} > ${params.createdAt})`;
}

function buildLimitViolationResponse(params: {
  entityType: LimitEntityType;
  entityId: string;
  limitValue: number;
  comparisonValue: number;
  limitDescription: "tokens" | "cost_dollars";
  totalTokensIn: number;
  totalTokensOut: number;
  cleanupInterval?: LimitCleanupInterval | null;
  models?: string[] | null;
}): LimitViolationResponse {
  if (!Number.isFinite(params.comparisonValue))
    return [
      "Usage accounting is incomplete.",
      `The ${archestraMcpBranding.appName} budget has incomplete billing usage. Ask an administrator to review provider usage and model prices before resetting the budget.`,
      { entityType: params.entityType, limitType: "token_cost" },
    ];
  const totalTokens = params.totalTokensIn + params.totalTokensOut;
  const remaining = Math.max(0, params.limitValue - params.comparisonValue);
  // Human-readable description of the exact rule that fired, so both the LLM
  // (via the metadata block) and the end user (via the content message) can
  // tell *which* Archestra limit blocked them rather than guessing.
  const scopeLabel = formatLimitEntityType(params.entityType);
  const modelScope = describeLimitModelScope(params.models);
  const resetWindow = describeLimitResetWindow(params.cleanupInterval);
  const archestraMetadata = `
<archestra-limit-type>token_cost</archestra-limit-type>
<archestra-limit-entity-type>${params.entityType}</archestra-limit-entity-type>
<archestra-limit-entity-id>${params.entityId}</archestra-limit-entity-id>
<archestra-limit-model-scope>${modelScope}</archestra-limit-model-scope>
<archestra-limit-reset-window>${resetWindow ?? "n/a"}</archestra-limit-reset-window>
<archestra-limit-current-usage>${totalTokens}</archestra-limit-current-usage>
<archestra-limit-value>${params.limitValue}</archestra-limit-value>
<archestra-limit-remaining>${remaining}</archestra-limit-remaining>`;

  // Lead with explicit platform attribution: clients were framing this as a
  // provider rate limit ("not your usage limit"), so the first line must make
  // clear that this platform enforced it — under the deployment's own brand,
  // since this string is returned straight to the end user.
  const header = `This request was blocked by ${archestraMcpBranding.appName} (not the AI provider): the ${scopeLabel} cost limit has been reached.`;
  const ruleLine = `Rule: ${scopeLabel} cost limit, applied to ${modelScope}${
    resetWindow ? `, resets ${resetWindow}` : ""
  }.`;
  const footer = resetWindow
    ? `Contact your administrator to raise the limit, or wait for the usage to reset (${resetWindow}).`
    : "Contact your administrator to raise the limit, or wait for the usage to reset.";

  const usageBlock =
    params.limitDescription === "cost_dollars"
      ? `Current usage: $${params.comparisonValue.toFixed(2)}
Limit: $${params.limitValue.toFixed(2)}
Remaining: $${remaining.toFixed(2)}`
      : `Current usage: ${totalTokens.toLocaleString()} tokens
Limit: ${params.limitValue.toLocaleString()} tokens
Remaining: ${Math.max(0, params.limitValue - totalTokens).toLocaleString()} tokens`;

  const contentMessage = `
${header}

${ruleLine}

${usageBlock}

${footer}`;

  return [
    `${archestraMetadata}\n${contentMessage}`,
    contentMessage,
    { entityType: params.entityType, limitType: "token_cost" },
  ];
}

/** Render a limit's entity type for human display, e.g. "virtual_key" -> "virtual key-level". */
function formatLimitEntityType(entityType: LimitEntityType): string {
  if (entityType === "llm_oauth_client") return "OAuth client-level";
  return `${entityType.replace(/_/g, " ")}-level`;
}

/** Describe which models a limit covers, e.g. "all models" or "models gpt-4o, claude-3-5-sonnet". */
function describeLimitModelScope(models?: string[] | null): string {
  const normalized = normalizeLimitModels(models);
  if (!normalized) {
    return "all models";
  }
  return normalized.length === 1
    ? `model ${normalized[0]}`
    : `models ${normalized.join(", ")}`;
}

/** Turn a cleanup interval into a human reset cadence, e.g. "every 24 hours", "monthly (calendar month)". */
function describeLimitResetWindow(
  interval?: LimitCleanupInterval | null,
): string | null {
  switch (interval) {
    case "1h":
      return "every hour";
    case "12h":
      return "every 12 hours";
    case "24h":
      return "every 24 hours";
    case "1w":
      return "every week";
    case "1m":
      return "every month";
    case "calendar_day":
      return "daily (calendar day)";
    case "calendar_week_sunday":
      return "weekly (calendar week, Sunday start)";
    case "calendar_week_monday":
      return "weekly (calendar week, Monday start)";
    case "calendar_month":
      return "monthly (calendar month)";
    default:
      return null;
  }
}

function normalizeLimitModels(models: string[] | null | undefined) {
  if (!models || models.length === 0) {
    return null;
  }

  return models;
}

export default LimitModel;
