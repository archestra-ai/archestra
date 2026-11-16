import { sql } from "drizzle-orm";
import { z } from "zod";
import db, { schema } from "@/database";
import {
  type CursorPaginatedResult,
  createCursorPaginatedResult,
  decodeCursor,
} from "@/database/utils/pagination";
import type { ActivityDay } from "@/types/openappa-remedies";

const operations = schema.openappaOperationsTable;
const consults = schema.openappaExternalConsultsTable;

/**
 * The operations the native runtime journaled. Rust writes every row; this
 * model only aggregates them.
 */
class OpenAppaOperationModel {
  /**
   * Denied tool calls per calendar day over the last `days` days, ending
   * today in `timeZone`, by how each ended: approved when an authority
   * answered one of the denial's offers with `approve`, cleaned when a
   * sanitizer answered one, blocked when neither did. A call counts once,
   * as approved before cleaned.
   */
  static async activityByDay(params: {
    organizationId: string;
    timeZone: string;
    days: number;
  }): Promise<ActivityDay[]> {
    const days = Math.max(1, Math.trunc(params.days));
    // A remedy is consulted after its denial, so both reads can start at the
    // same instant, one day before the window to cover the zone offset.
    const since = sql`now() - make_interval(days => ${sql.raw(String(days + 1))})`;
    const result = await db.execute<ActivityDay>(sql`
      WITH days AS (
        SELECT to_char(
          date_trunc('day', now() AT TIME ZONE ${params.timeZone}) - make_interval(days => n),
          'YYYY-MM-DD'
        ) AS date
        FROM generate_series(${sql.raw(String(days - 1))}, 0, -1) AS n
      ),
      blocked AS (
        SELECT o.session_id, o.operation_id, o.decision,
          to_char(date_trunc('day', o.created_at AT TIME ZONE ${params.timeZone}), 'YYYY-MM-DD') AS date
        FROM ${operations} AS o
        WHERE o.organization_id = ${params.organizationId}
          AND o.created_at >= ${since}
          AND o.status = 'complete'
          AND COALESCE(o.input->'semantic'->>'event', o.input->>'event') = 'tool_call'
          AND o.decision->>'decision' = 'deny_call'
      ),
      lifted AS (
        SELECT b.session_id, b.operation_id,
          BOOL_OR(c.role = 'authority' AND c.answer->>'ruling' = 'approve') AS approved,
          BOOL_OR(c.role = 'sanitizer') AS cleaned
        FROM blocked AS b
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b.decision->'offers', '[]'::jsonb)) AS offer
        JOIN ${consults} AS c
          ON c.organization_id = ${params.organizationId}
          AND c.created_at >= ${since}
          -- Decisions carry the rendered offer id, a prefix of the canonical one a consult stores.
          AND offer->>'offer_id' <> ''
          AND starts_with(c.offer_id, offer->>'offer_id')
          AND c.outcome = 'answered'
        GROUP BY b.session_id, b.operation_id
      )
      SELECT d.date,
        COUNT(b.operation_id) FILTER (WHERE NOT COALESCE(l.approved, false) AND NOT COALESCE(l.cleaned, false))::int AS blocked,
        COUNT(b.operation_id) FILTER (WHERE l.approved)::int AS approved,
        COUNT(b.operation_id) FILTER (WHERE l.cleaned AND NOT l.approved)::int AS cleaned
      FROM days AS d
      LEFT JOIN blocked AS b ON b.date = d.date
      LEFT JOIN lifted AS l
        ON l.session_id = b.session_id AND l.operation_id = b.operation_id
      GROUP BY d.date
      ORDER BY d.date
    `);
    return result.rows.map((row) => ({
      date: row.date,
      blocked: Number(row.blocked),
      approved: Number(row.approved),
      cleaned: Number(row.cleaned),
    }));
  }

  /**
   * Tool calls the policy denied in `(since, until]`, per tool, most denied
   * first. Receipts sealed away from SQL name no tool and are left out.
   */
  static async deniedCallsByTool(params: {
    organizationId: string;
    since: Date;
    until: Date;
    limit: number;
    evidenceLimit: number;
  }): Promise<DeniedCallsByTool[]> {
    const result = await db.execute(sql`
      WITH denied AS (
        SELECT o.session_id, o.operation_id, o.created_at,
          COALESCE(o.input->'semantic'->>'tool', o.input->'context'->>'tool', o.input->>'tool') AS tool
        FROM ${operations} AS o
        WHERE o.organization_id = ${params.organizationId}
          AND o.created_at > ${params.since.toISOString()}::timestamptz
          AND o.created_at <= ${params.until.toISOString()}::timestamptz
          AND o.status = 'complete'
          AND COALESCE(o.input->'semantic'->>'event', o.input->>'event') = 'tool_call'
          AND o.decision->>'decision' = 'deny_call'
      ),
      ranked AS (
        SELECT denied.*,
          ROW_NUMBER() OVER (PARTITION BY tool ORDER BY created_at DESC, operation_id DESC) AS rn
        FROM denied
        WHERE tool IS NOT NULL AND tool <> ''
      )
      SELECT tool,
        COUNT(*)::int AS denials,
        COUNT(DISTINCT session_id)::int AS sessions,
        MIN(created_at) AS first_at,
        MAX(created_at) AS last_at,
        COALESCE(to_jsonb((ARRAY_AGG(
          jsonb_build_object('sessionId', session_id, 'operationId', operation_id)
          ORDER BY created_at DESC, operation_id DESC
        ) FILTER (WHERE rn <= ${params.evidenceLimit}::int))[1:${params.evidenceLimit}::int]), '[]'::jsonb) AS recent
      FROM ranked
      GROUP BY tool
      ORDER BY denials DESC, tool
      LIMIT ${params.limit}
    `);
    return DeniedCallsByToolRowSchema.array().parse(result.rows);
  }

  /**
   * Completed operations newest first: which tool, in which session, and
   * what was decided, never the arguments. Sealed receipts are left out.
   */
  static async findCursorPaginated(params: {
    organizationId: string;
    /** Only this caller's operations; absent reads the whole organization. */
    callerId?: string;
    tool?: string;
    decision?: OpenAppaOperationDecision;
    since: Date;
    limit: number;
    cursor?: string;
  }): Promise<CursorPaginatedResult<OperationSummary>> {
    const tool = sql`COALESCE(o.input->'semantic'->>'tool', o.input->'context'->>'tool', o.input->>'tool')`;
    const conditions = [
      sql`o.organization_id = ${params.organizationId}`,
      sql`o.status = 'complete'`,
      sql`o.created_at >= ${params.since.toISOString()}::timestamptz`,
      sql`o.input->>'__appa_encrypted' IS NULL`,
      sql`o.decision->>'__appa_encrypted' IS NULL`,
    ];
    if (params.callerId) conditions.push(sql`o.caller_id = ${params.callerId}`);
    if (params.tool) conditions.push(sql`${tool} = ${params.tool}`);
    if (params.decision)
      conditions.push(sql`o.decision->>'decision' = ${params.decision}`);
    const position = operationCursorPosition(params.cursor);
    if (position)
      conditions.push(
        sql`(o.created_at, o.session_id, o.operation_id) < (${position.at}::timestamptz, ${position.sessionId}, ${position.operationId})`,
      );
    const result = await db.execute(sql`
      SELECT o.session_id, o.operation_id, ${tool} AS tool,
        COALESCE(o.input->'semantic'->>'event', o.input->>'event') AS event,
        o.decision->>'decision' AS decision,
        to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
      FROM ${operations} AS o
      WHERE ${sql.join(conditions, sql` AND `)}
      ORDER BY o.created_at DESC, o.session_id DESC, o.operation_id DESC
      LIMIT ${params.limit + 1}
    `);
    return createCursorPaginatedResult(
      OperationSummaryRowSchema.array().parse(result.rows),
      { limit: params.limit, cursor: params.cursor },
      (row) => ({
        value: row.cursorAt,
        id: JSON.stringify([row.sessionId, row.operationId]),
      }),
    );
  }
}

/** The values `decision->>'decision'` holds. */
export const OpenAppaOperationDecisionSchema = z.enum([
  "ack",
  "allow_call",
  "pass_control",
  "deny_call",
  "block",
  "replace_output",
  "deliver_value",
  "child_return",
  "context",
  "refuse",
]);
type OpenAppaOperationDecision = z.infer<
  typeof OpenAppaOperationDecisionSchema
>;

const OperationSummaryRowSchema = z
  .object({
    session_id: z.string(),
    operation_id: z.string(),
    tool: z.string().nullable(),
    event: z.string().nullable(),
    decision: z.string().nullable(),
    created_at: z.string(),
  })
  .transform((row) => ({
    sessionId: row.session_id,
    operationId: row.operation_id,
    tool: row.tool,
    event: row.event,
    decision: row.decision,
    createdAt: new Date(row.created_at),
    // Microsecond precision, so the next page neither repeats nor skips rows.
    cursorAt: row.created_at,
  }));
type OperationSummary = z.infer<typeof OperationSummaryRowSchema>;

const OperationCursorIdSchema = z.tuple([z.string(), z.string()]);

/** An unreadable cursor is treated as none: the newest page. */
function operationCursorPosition(cursor: string | undefined) {
  const position = decodeCursor(cursor);
  if (!position || Number.isNaN(new Date(position.value).getTime()))
    return null;
  try {
    const id = OperationCursorIdSchema.safeParse(JSON.parse(position.id));
    return id.success
      ? {
          at: position.value,
          sessionId: id.data[0],
          operationId: id.data[1],
        }
      : null;
  } catch {
    return null;
  }
}

const DeniedCallsByToolRowSchema = z
  .object({
    tool: z.string(),
    denials: z.number().int(),
    sessions: z.number().int(),
    first_at: z.coerce.date(),
    last_at: z.coerce.date(),
    recent: z.array(
      z.object({ sessionId: z.string(), operationId: z.string() }),
    ),
  })
  .transform(({ first_at, last_at, ...row }) => ({
    ...row,
    firstAt: first_at,
    lastAt: last_at,
  }));
type DeniedCallsByTool = z.infer<typeof DeniedCallsByToolRowSchema>;

export default OpenAppaOperationModel;
