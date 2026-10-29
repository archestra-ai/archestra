import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
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
          AND c.offer_id = offer->>'offer_id'
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
}

export default OpenAppaOperationModel;
