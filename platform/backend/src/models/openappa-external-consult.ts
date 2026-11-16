import { and, desc, eq, gte, inArray, lte, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import db, { schema } from "@/database";
import {
  type CursorPaginatedResult,
  createCursorPaginatedResult,
  decodeCursor,
  encodeCursor,
} from "@/database/utils/pagination";
import { buildTokenizedSearchFilter } from "@/database/utils/text-search";
import { openPlainJson } from "@/openappa/plaintext-envelope";
import type {
  ExternalConsult,
  ExternalConsultOutcome,
  ExternalConsultRole,
} from "@/types/openappa-external-consults";

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
      cursorPosition,
    );
  }

  /** One consult, when it is in the organization and the caller may read it. */
  static async findById(params: {
    organizationId: string;
    id: string;
    callerId?: string;
  }): Promise<ExternalConsult | null> {
    if (!UUID.test(params.id)) return null;
    const conditions: SQL[] = [
      eq(table.organizationId, params.organizationId),
      eq(table.id, params.id),
    ];
    if (params.callerId) conditions.push(eq(table.callerId, params.callerId));
    const [row] = await db
      .select()
      .from(table)
      .where(and(...conditions))
      .limit(1);
    return row ? readable(row) : null;
  }

  /** The cursor that continues right after `row`, for a page cut short. */
  static cursorAfter(row: ExternalConsult): string {
    return encodeCursor(cursorPosition(row));
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
   * Answered human-review (`hitl` authority) consults in `(since, until]`,
   * per tool of the denied call whose offer they ruled on, busiest first.
   * The ruling lives in the answer, so a consult whose answer was not
   * stored (metadata-only logging) or is sealed counts as `unreadable`.
   * A consult whose denied call is sealed names no tool and is left out.
   */
  static async hitlRulingsByTool(params: {
    organizationId: string;
    since: Date;
    until: Date;
    limit: number;
    evidenceLimit: number;
  }): Promise<HitlRulingsByTool[]> {
    const operations = schema.openappaOperationsTable;
    const since = params.since.toISOString();
    const until = params.until.toISOString();
    const result = await db.execute(sql`
      WITH offered AS (
        SELECT DISTINCT ON (offer.id) offer.id AS offer_id,
          COALESCE(o.input->'semantic'->>'tool', o.input->'context'->>'tool', o.input->>'tool') AS tool
        FROM ${operations} AS o
        CROSS JOIN LATERAL (
          SELECT jsonb_path_query(o.decision, 'lax $.offers[*].offer_id') #>> '{}'
          UNION
          SELECT jsonb_path_query(o.decision, 'lax $.review[*].offer_id') #>> '{}'
        ) AS offer(id)
        WHERE o.organization_id = ${params.organizationId}
          -- A review is answered after the denial that offered it.
          AND o.created_at > ${since}::timestamptz - interval '1 day'
          AND o.created_at <= ${until}::timestamptz
          AND o.status = 'complete'
          AND o.decision->>'decision' = 'deny_call'
      ),
      ruled AS (
        SELECT c.id, c.session_id, c.created_at, offered.tool,
          CASE c.answer->>'ruling'
            WHEN 'approve' THEN 'approve'
            WHEN 'deny' THEN 'deny'
            ELSE 'unreadable'
          END AS ruling
        FROM ${table} AS c
        JOIN offered ON offered.offer_id = c.offer_id
        WHERE c.organization_id = ${params.organizationId}
          AND c.created_at > ${since}::timestamptz
          AND c.created_at <= ${until}::timestamptz
          AND c.role = 'authority'
          AND c.backend = 'hitl'
          AND c.outcome = 'answered'
      ),
      ranked AS (
        SELECT ruled.*,
          ROW_NUMBER() OVER (PARTITION BY tool, ruling ORDER BY created_at DESC, id DESC) AS rn
        FROM ruled
        WHERE tool IS NOT NULL AND tool <> ''
      )
      SELECT tool,
        COUNT(*) FILTER (WHERE ruling = 'approve')::int AS approved,
        COUNT(*) FILTER (WHERE ruling = 'deny')::int AS denied,
        COUNT(*) FILTER (WHERE ruling = 'unreadable')::int AS unreadable,
        COUNT(DISTINCT session_id)::int AS sessions,
        MIN(created_at) AS first_at,
        MAX(created_at) AS last_at,
        COALESCE(to_jsonb((ARRAY_AGG(id::text ORDER BY created_at DESC, id DESC)
          FILTER (WHERE ruling = 'approve' AND rn <= ${params.evidenceLimit}::int))[1:${params.evidenceLimit}::int]), '[]'::jsonb) AS approved_ids,
        COALESCE(to_jsonb((ARRAY_AGG(id::text ORDER BY created_at DESC, id DESC)
          FILTER (WHERE ruling = 'deny' AND rn <= ${params.evidenceLimit}::int))[1:${params.evidenceLimit}::int]), '[]'::jsonb) AS denied_ids
      FROM ranked
      GROUP BY tool
      ORDER BY COUNT(*) DESC, tool
      LIMIT ${params.limit}
    `);
    return HitlRulingsByToolRowSchema.array().parse(result.rows);
  }

  /**
   * Approvals the stock `approve` authority gave in `(since, until]`: the
   * policy approved the call without asking anyone. Per the governed tool
   * the request names, which metadata-only logging keeps; a sealed request
   * names none and is left out.
   */
  static async stockApprovalsByTool(params: {
    organizationId: string;
    since: Date;
    until: Date;
    limit: number;
    evidenceLimit: number;
  }): Promise<StockApprovalsByTool[]> {
    const result = await db.execute(sql`
      WITH approved AS (
        SELECT c.id, c.session_id, c.created_at,
          c.request->'artifact'->>'tool' AS tool
        FROM ${table} AS c
        WHERE c.organization_id = ${params.organizationId}
          AND c.created_at > ${params.since.toISOString()}::timestamptz
          AND c.created_at <= ${params.until.toISOString()}::timestamptz
          AND c.role = 'authority'
          AND c.backend = 'stock'
          AND c.outcome = 'answered'
      ),
      ranked AS (
        SELECT approved.*,
          ROW_NUMBER() OVER (PARTITION BY tool ORDER BY created_at DESC, id DESC) AS rn
        FROM approved
        WHERE tool IS NOT NULL AND tool <> ''
      )
      SELECT tool,
        COUNT(*)::int AS approvals,
        COUNT(DISTINCT session_id)::int AS sessions,
        MIN(created_at) AS first_at,
        MAX(created_at) AS last_at,
        COALESCE(to_jsonb((ARRAY_AGG(id::text ORDER BY created_at DESC, id DESC)
          FILTER (WHERE rn <= ${params.evidenceLimit}::int))[1:${params.evidenceLimit}::int]), '[]'::jsonb) AS recent_ids
      FROM ranked
      GROUP BY tool
      ORDER BY approvals DESC, tool
      LIMIT ${params.limit}
    `);
    return StockApprovalsByToolRowSchema.array().parse(result.rows);
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
    if (filters.llmSessionId) {
      // The LLM session id is the client's own session id, the part after
      // the caller scope in OpenAPPA's session id. Matching it to session
      // families (indexed on that suffix) and then consults by root brings
      // in every trajectory of the session, sub-agents included.
      const sessions = schema.openappaSessionsTable;
      conditions.push(
        inArray(
          table.root,
          db
            .select({ root: sessions.root })
            .from(sessions)
            .where(
              and(
                eq(sessions.organizationId, params.organizationId),
                sql`substr(${sessions.sessionId}, strpos(${sessions.sessionId}, '|') + 1) = ${filters.llmSessionId}`,
              ),
            ),
        ),
      );
    }
    // Neither column is indexed: like the exact filters above, this narrows
    // the newest-first walk of the (organization, created_at) index row by row.
    const search = buildTokenizedSearchFilter({
      query: filters.search,
      columns: [table.externalName, table.sessionId],
    });
    if (search) conditions.push(search);

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

    const rows = await db
      .select()
      .from(table)
      .where(and(...conditions))
      .orderBy(desc(table.createdAt), desc(table.id))
      .limit(params.size);
    return rows.map(readable);
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
  /** The LLM session (client session id) the consults were raised in. */
  llmSessionId?: string;
  /** Case-insensitive substring of the external's name or the session ID. */
  search?: string;
}

function cursorPosition(row: ExternalConsult) {
  return { value: row.createdAt.toISOString(), id: row.id };
}

/**
 * A consult as the runtime recorded it: a request or answer holding a NUL
 * character is stored in the plaintext escape envelope and read through it.
 */
function readable(row: ExternalConsult): ExternalConsult {
  return {
    ...row,
    request: openPlainJson(row.request),
    answer: openPlainJson(row.answer),
  };
}

const ToolSpanRowSchema = z.object({
  tool: z.string(),
  sessions: z.number().int(),
  first_at: z.coerce.date(),
  last_at: z.coerce.date(),
});

const HitlRulingsByToolRowSchema = ToolSpanRowSchema.extend({
  approved: z.number().int(),
  denied: z.number().int(),
  unreadable: z.number().int(),
  approved_ids: z.array(z.uuid()),
  denied_ids: z.array(z.uuid()),
}).transform(({ first_at, last_at, approved_ids, denied_ids, ...row }) => ({
  ...row,
  firstAt: first_at,
  lastAt: last_at,
  approvedIds: approved_ids,
  deniedIds: denied_ids,
}));
type HitlRulingsByTool = z.infer<typeof HitlRulingsByToolRowSchema>;

const StockApprovalsByToolRowSchema = ToolSpanRowSchema.extend({
  approvals: z.number().int(),
  recent_ids: z.array(z.uuid()),
}).transform(({ first_at, last_at, recent_ids, ...row }) => ({
  ...row,
  firstAt: first_at,
  lastAt: last_at,
  recentIds: recent_ids,
}));
type StockApprovalsByTool = z.infer<typeof StockApprovalsByToolRowSchema>;

const EXPORT_PAGE_SIZE = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default OpenappaExternalConsultModel;
