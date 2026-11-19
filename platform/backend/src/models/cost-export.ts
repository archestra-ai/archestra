import { and, asc, count, eq, isNull, lt, or, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  CostExport,
  CostExportRunStatus,
  CostExportUsageRow,
} from "@/types";
import { interactionBelongsToOrganization } from "./log-organization";
import { usageFacts } from "./statistics";

class CostExportModel {
  static async findByOrganization(
    organizationId: string,
  ): Promise<(CostExport & { blobProviderName: string })[]> {
    const rows = await db
      .select({
        export: schema.costExportsTable,
        blobProviderName: schema.blobProvidersTable.name,
      })
      .from(schema.costExportsTable)
      .innerJoin(
        schema.blobProvidersTable,
        eq(
          schema.blobProvidersTable.id,
          schema.costExportsTable.blobProviderId,
        ),
      )
      .where(eq(schema.costExportsTable.organizationId, organizationId))
      .orderBy(asc(schema.costExportsTable.name));
    return rows.map((row) => ({
      ...row.export,
      blobProviderName: row.blobProviderName,
    }));
  }

  static async findById(params: {
    id: string;
    organizationId: string;
  }): Promise<(CostExport & { blobProviderName: string }) | null> {
    const [row] = await db
      .select({
        export: schema.costExportsTable,
        blobProviderName: schema.blobProvidersTable.name,
      })
      .from(schema.costExportsTable)
      .innerJoin(
        schema.blobProvidersTable,
        eq(
          schema.blobProvidersTable.id,
          schema.costExportsTable.blobProviderId,
        ),
      )
      .where(
        and(
          eq(schema.costExportsTable.id, params.id),
          eq(schema.costExportsTable.organizationId, params.organizationId),
        ),
      );
    return row
      ? { ...row.export, blobProviderName: row.blobProviderName }
      : null;
  }

  /** Enabled exports across organizations, for the periodic task. */
  static async findEnabledById(id: string): Promise<CostExport | null> {
    const [row] = await db
      .select()
      .from(schema.costExportsTable)
      .where(
        and(
          eq(schema.costExportsTable.id, id),
          eq(schema.costExportsTable.enabled, true),
        ),
      );
    return row ?? null;
  }

  static async findEnabled(): Promise<CostExport[]> {
    return db
      .select()
      .from(schema.costExportsTable)
      .where(eq(schema.costExportsTable.enabled, true));
  }

  /** Names of the exports that write to each of the organization's providers. */
  static async namesByBlobProvider(
    organizationId: string,
  ): Promise<Map<string, string[]>> {
    const t = schema.costExportsTable;
    const rows = await db
      .select({ blobProviderId: t.blobProviderId, name: t.name })
      .from(t)
      .where(eq(t.organizationId, organizationId))
      .orderBy(asc(t.name));
    const names = new Map<string, string[]>();
    for (const row of rows) {
      names.set(row.blobProviderId, [
        ...(names.get(row.blobProviderId) ?? []),
        row.name,
      ]);
    }
    return names;
  }

  static async countByBlobProvider(blobProviderId: string): Promise<number> {
    const [row] = await db
      .select({ value: count() })
      .from(schema.costExportsTable)
      .where(eq(schema.costExportsTable.blobProviderId, blobProviderId));
    return row?.value ?? 0;
  }

  static async create(
    data: Pick<
      CostExport,
      | "organizationId"
      | "blobProviderId"
      | "name"
      | "enabled"
      | "format"
      | "schedule"
      | "pathPrefix"
      | "exportedThrough"
    >,
  ): Promise<CostExport> {
    const [row] = await db
      .insert(schema.costExportsTable)
      .values(data)
      .returning();
    return row;
  }

  static async update(
    params: { id: string; organizationId: string },
    data: Partial<
      Pick<
        CostExport,
        | "blobProviderId"
        | "name"
        | "enabled"
        | "format"
        | "schedule"
        | "pathPrefix"
        | "exportedThrough"
      >
    >,
  ): Promise<CostExport | null> {
    const [row] = await db
      .update(schema.costExportsTable)
      .set(data)
      .where(
        and(
          eq(schema.costExportsTable.id, params.id),
          eq(schema.costExportsTable.organizationId, params.organizationId),
        ),
      )
      .returning();
    return row ?? null;
  }

  static async delete(params: {
    id: string;
    organizationId: string;
  }): Promise<boolean> {
    const rows = await db
      .delete(schema.costExportsTable)
      .where(
        and(
          eq(schema.costExportsTable.id, params.id),
          eq(schema.costExportsTable.organizationId, params.organizationId),
        ),
      )
      .returning({ id: schema.costExportsTable.id });
    return rows.length > 0;
  }

  /**
   * Take the run lease, unless another run holds it. Returns the export as it
   * is now, or null. Its `runningUntil` identifies this claim: the queued run
   * hands it to {@link resumeRun}.
   */
  static async claimRun(params: {
    id: string;
    leaseSeconds: number;
  }): Promise<(CostExport & { runningUntil: Date }) | null> {
    const t = schema.costExportsTable;
    // Millisecond precision, so the value round-trips through a task payload.
    const runningUntil = new Date(Date.now() + params.leaseSeconds * 1000);
    const [row] = await db
      .update(t)
      .set({ runningUntil })
      .where(
        and(
          eq(t.id, params.id),
          or(isNull(t.runningUntil), lt(t.runningUntil, sql`NOW()`)),
        ),
      )
      .returning();
    return row ? { ...row, runningUntil } : null;
  }

  /**
   * Renew a claim from {@link claimRun} for the run that holds it. Null when
   * the claim is gone: it expired and another run took the lease, or the
   * export was deleted.
   */
  static async resumeRun(params: {
    id: string;
    claimedUntil: Date;
    leaseSeconds: number;
  }): Promise<CostExport | null> {
    const t = schema.costExportsTable;
    const [row] = await db
      .update(t)
      .set({
        runningUntil: new Date(Date.now() + params.leaseSeconds * 1000),
      })
      .where(and(eq(t.id, params.id), eq(t.runningUntil, params.claimedUntil)))
      .returning();
    return row ?? null;
  }

  /** Give a claim back unused (its run could not be queued). */
  static async releaseRun(params: {
    id: string;
    claimedUntil: Date;
  }): Promise<void> {
    const t = schema.costExportsTable;
    await db
      .update(t)
      .set({ runningUntil: null })
      .where(and(eq(t.id, params.id), eq(t.runningUntil, params.claimedUntil)));
  }

  /** Record a run's outcome and release the lease. */
  static async finishRun(params: {
    id: string;
    status: CostExportRunStatus;
    error: string | null;
    exportedThrough?: Date;
    lastObjectKey?: string;
  }): Promise<void> {
    await db
      .update(schema.costExportsTable)
      .set({
        runningUntil: null,
        lastRunAt: new Date(),
        lastRunStatus: params.status,
        lastRunError: params.error,
        consecutiveFailures:
          params.status === "failed"
            ? sql`${schema.costExportsTable.consecutiveFailures} + 1`
            : 0,
        ...(params.exportedThrough
          ? { exportedThrough: params.exportedThrough }
          : {}),
        ...(params.lastObjectKey
          ? { lastObjectKey: params.lastObjectKey }
          : {}),
      })
      .where(eq(schema.costExportsTable.id, params.id));
  }

  /**
   * LLM usage of `[start, end)` for one organization, one row per hour and
   * charge: provider, billed model, billing mode, billing team, agent (or app
   * or connector), and user. Numbers are each billing receipt's per-model
   * split, the same view the Models statistics use.
   */
  static async usageForPeriod(params: {
    organizationId: string;
    start: Date;
    end: Date;
  }): Promise<CostExportUsageRow[]> {
    // `custom:` ranges are inclusive of their end.
    const f = await usageFacts(
      `custom:${params.start.toISOString()}_${new Date(params.end.getTime() - 1).toISOString()}`,
    );
    const a = schema.agentsTable;
    const app = schema.appsTable;
    const c = schema.knowledgeBaseConnectorsTable;
    const t = schema.teamsTable;
    const u = schema.usersTable;
    const sum = (column: unknown) =>
      sql<string>`COALESCE(SUM(${column}), 0)::text`;
    const hour = sql<string>`DATE_TRUNC('hour', ${f.hour})`;
    const model = sql<string | null>`COALESCE(${f.billedModel}, ${f.model})`;
    const rows = await db
      .select({
        hour: sql<string>`(${hour})::text`,
        provider: f.type,
        model,
        billingMode: f.billingMode,
        teamId: f.billingTeamId,
        teamName: sql<string | null>`MAX(${t.name})`,
        agentId: f.profileId,
        agentName: sql<string | null>`MAX(${a.name})`,
        agentType: sql<string | null>`MAX(${a.agentType})`,
        appId: f.appId,
        appName: sql<string | null>`MAX(${app.name})`,
        connectorId: f.connectorId,
        connectorName: sql<string | null>`MAX(${c.name})`,
        userId: f.userId,
        userEmail: sql<string | null>`MAX(${u.email})`,
        requests: sum(f.requests),
        inputTokens: sum(f.modelInputTokens),
        outputTokens: sum(f.modelOutputTokens),
        cacheReadTokens: sum(f.modelCacheReadTokens),
        cacheWriteTokens: sum(f.modelCacheWriteTokens),
        cost: sum(f.modelCost),
      })
      .from(f)
      .leftJoin(a, eq(a.id, f.profileId))
      .leftJoin(app, eq(app.id, f.appId))
      .leftJoin(c, eq(c.id, f.connectorId))
      .leftJoin(t, eq(t.id, f.billingTeamId))
      .leftJoin(u, eq(u.id, f.userId))
      .where(interactionBelongsToOrganization(params.organizationId, f))
      .groupBy(
        hour,
        f.type,
        model,
        f.billingMode,
        f.billingTeamId,
        f.profileId,
        f.appId,
        f.connectorId,
        f.userId,
      )
      .having(
        sql`SUM(${f.requests}) > 0 OR SUM(${f.modelCost}) <> 0 OR SUM(${f.modelInputTokens} + ${f.modelOutputTokens}) > 0`,
      )
      .orderBy(hour, f.type, model);
    return rows;
  }

  /** Audit snapshot. */
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    const row = await CostExportModel.findById({ id, organizationId });
    if (!row) return null;
    const { runningUntil: _runningUntil, ...snapshot } = row;
    return snapshot;
  }
}

export default CostExportModel;
