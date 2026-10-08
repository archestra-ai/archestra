import { and, desc, eq, gte, inArray, lte, type SQL, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  type CursorPaginatedResult,
  createCursorPaginatedResult,
  decodeCursor,
} from "@/database/utils/pagination";
import type {
  ExternalConsult,
  ExternalConsultOutcome,
  ExternalConsultRole,
} from "@/types/openappa-external-consults";
import type { ConsultActivityDay } from "@/types/openappa-remedies";

const table = schema.openappaExternalConsultsTable;

/**
 * The external consults the native runtime recorded. Rust writes every row;
 * this model only reads and expires them.
 */
class OpenappaExternalConsultModel {
  /** Newest first, keyed on `(created_at, id)`. */
  static async findCursorPaginated(params: {
    organizationId: string;
    filters: ExternalConsultFilters;
    limit: number;
    cursor?: string;
  }): Promise<CursorPaginatedResult<ExternalConsult>> {
    const rows = await OpenappaExternalConsultModel.page({
      ...params,
      size: params.limit + 1,
    });
    return createCursorPaginatedResult(
      rows,
      { limit: params.limit, cursor: params.cursor },
      (row) => ({ value: row.createdAt.toISOString(), id: row.id }),
    );
  }

  /** Up to `max` rows in the same order, read a page at a time. */
  static async *exportRows(params: {
    organizationId: string;
    filters: ExternalConsultFilters;
    max: number;
    cursor?: string;
  }): AsyncGenerator<ExternalConsult> {
    let cursor = params.cursor;
    let remaining = params.max;
    while (remaining > 0) {
      const page = await OpenappaExternalConsultModel.findCursorPaginated({
        organizationId: params.organizationId,
        filters: params.filters,
        limit: Math.min(EXPORT_PAGE_SIZE, remaining),
        cursor,
      });
      yield* page.data;
      remaining -= page.data.length;
      if (!page.pagination.nextCursor) return;
      cursor = page.pagination.nextCursor;
    }
  }

  /** The newest consult of each named external in one role, by name. */
  static async findLatestByExternalName(params: {
    organizationId: string;
    role: ExternalConsultRole;
    externalNames: string[];
  }): Promise<Map<string, Pick<ExternalConsult, "outcome" | "createdAt">>> {
    if (params.externalNames.length === 0) return new Map();
    const rows = await db
      .selectDistinctOn([table.externalName], {
        externalName: table.externalName,
        outcome: table.outcome,
        createdAt: table.createdAt,
      })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(table.role, params.role),
          inArray(table.externalName, params.externalNames),
        ),
      )
      .orderBy(table.externalName, desc(table.createdAt), desc(table.id));
    return new Map(
      rows.map(({ externalName, ...latest }) => [externalName, latest]),
    );
  }

  /**
   * What authorities and sanitizers answered per calendar day over the last
   * `days` days, ending today in `timeZone`: reviews approved and denied,
   * and results or arguments cleaned. Consults that got no answer are left
   * out.
   */
  static async activityByDay(params: {
    organizationId: string;
    timeZone: string;
    days: number;
  }): Promise<ConsultActivityDay[]> {
    const days = Math.max(1, Math.trunc(params.days));
    // One day before the window covers the zone offset.
    const since = sql`now() - make_interval(days => ${sql.raw(String(days + 1))})`;
    const result = await db.execute<ConsultActivityDay>(sql`
      WITH days AS (
        SELECT to_char(
          date_trunc('day', now() AT TIME ZONE ${params.timeZone}) - make_interval(days => n),
          'YYYY-MM-DD'
        ) AS date
        FROM generate_series(${sql.raw(String(days - 1))}, 0, -1) AS n
      ),
      answered AS (
        SELECT c.role, c.answer->>'ruling' AS ruling,
          to_char(date_trunc('day', c.created_at AT TIME ZONE ${params.timeZone}), 'YYYY-MM-DD') AS date
        FROM ${table} AS c
        WHERE c.organization_id = ${params.organizationId}
          AND c.created_at >= ${since}
          AND c.outcome = 'answered'
          AND c.role IN ('authority', 'sanitizer')
      )
      SELECT d.date,
        COUNT(a.role) FILTER (WHERE a.role = 'authority' AND a.ruling = 'approve')::int AS approved,
        COUNT(a.role) FILTER (WHERE a.role = 'authority' AND a.ruling = 'deny')::int AS denied,
        COUNT(a.role) FILTER (WHERE a.role = 'sanitizer')::int AS cleaned
      FROM days AS d
      LEFT JOIN answered AS a ON a.date = d.date
      GROUP BY d.date
      ORDER BY d.date
    `);
    return result.rows.map((row) => ({
      date: row.date,
      approved: Number(row.approved),
      denied: Number(row.denied),
      cleaned: Number(row.cleaned),
    }));
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /** Enterprise data-retention sweep: delete consults older than the window, in batches. */
  static async deleteExpired(params: {
    retentionDays: number;
    batchSize?: number;
    maxBatches?: number;
  }): Promise<number> {
    const batchSize = params.batchSize ?? 1000;
    const maxBatches = params.maxBatches ?? 500;
    let totalDeleted = 0;

    for (let batch = 0; batch < maxBatches; batch++) {
      const result = await db.execute<{ deleted: number }>(sql`
        WITH fence AS (
          SELECT id
          FROM ${table}
          WHERE created_at < now() - make_interval(days => ${params.retentionDays})
          LIMIT ${batchSize}
        ),
        removed AS (
          DELETE FROM ${table}
          WHERE id IN (SELECT id FROM fence)
          RETURNING 1
        )
        SELECT COUNT(*)::int AS deleted FROM removed
      `);
      const deleted = Number(result.rows[0]?.deleted ?? 0);
      totalDeleted += deleted;
      if (deleted < batchSize) break;
    }

    return totalDeleted;
  }
  // SPDX-SnippetEnd

  private static async page(params: {
    organizationId: string;
    filters: ExternalConsultFilters;
    size: number;
    cursor?: string;
  }): Promise<ExternalConsult[]> {
    const { filters } = params;
    const conditions: SQL[] = [eq(table.organizationId, params.organizationId)];
    if (filters.externalName)
      conditions.push(eq(table.externalName, filters.externalName));
    if (filters.role) conditions.push(eq(table.role, filters.role));
    if (filters.outcome) conditions.push(eq(table.outcome, filters.outcome));
    if (filters.from) conditions.push(gte(table.createdAt, filters.from));
    if (filters.to) conditions.push(lte(table.createdAt, filters.to));
    if (filters.root) conditions.push(eq(table.root, filters.root));
    if (filters.sessionId)
      conditions.push(eq(table.sessionId, filters.sessionId));
    if (filters.callerId) conditions.push(eq(table.callerId, filters.callerId));

    // An unreadable cursor is treated as none: the newest page.
    const position = decodeCursor(params.cursor);
    if (
      position &&
      !Number.isNaN(new Date(position.value).getTime()) &&
      UUID.test(position.id)
    ) {
      conditions.push(
        sql`(${table.createdAt}, ${table.id}) < (${position.value}::timestamptz, ${position.id}::uuid)`,
      );
    }

    return db
      .select()
      .from(table)
      .where(and(...conditions))
      .orderBy(desc(table.createdAt), desc(table.id))
      .limit(params.size);
  }
}

export interface ExternalConsultFilters {
  externalName?: string;
  role?: ExternalConsultRole;
  outcome?: ExternalConsultOutcome;
  from?: Date;
  to?: Date;
  root?: string;
  sessionId?: string;
  callerId?: string;
}

const EXPORT_PAGE_SIZE = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default OpenappaExternalConsultModel;
