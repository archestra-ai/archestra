import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { BlockedCallsDay } from "@/types/openappa-remedies";

const operations = schema.openappaOperationsTable;
const consults = schema.openappaExternalConsultsTable;

/**
 * The operations the native runtime journaled. Rust writes every row; this
 * model only aggregates them.
 */
class OpenAppaOperationModel {
  /**
   * Denied tool calls per calendar day over the last `days` days, ending
   * today in `timeZone`, with how many of them a remedy then let through.
   * A denial names its offers; a call got through when an authority answered
   * one of them with `approve`, or a sanitizer answered one at all.
   */
  static async blockedCallsByDay(params: {
    organizationId: string;
    timeZone: string;
    days: number;
  }): Promise<BlockedCallsDay[]> {
    const days = Math.max(1, Math.trunc(params.days));
    // A remedy is consulted after its denial, so both reads can start at the
    // same instant, one day before the window to cover the zone offset.
    const since = sql`now() - make_interval(days => ${sql.raw(String(days + 1))})`;
    const result = await db.execute<BlockedCallsDay>(sql`
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
      remedied AS (
        SELECT DISTINCT b.session_id, b.operation_id
        FROM blocked AS b
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(b.decision->'offers', '[]'::jsonb)) AS offer
        JOIN ${consults} AS c
          ON c.organization_id = ${params.organizationId}
          AND c.created_at >= ${since}
          AND c.offer_id = offer->>'offer_id'
          AND c.outcome = 'answered'
          AND (
            (c.role = 'authority' AND c.answer->>'ruling' = 'approve')
            OR c.role = 'sanitizer'
          )
      )
      SELECT d.date,
        COUNT(b.operation_id)::int AS blocked,
        COUNT(r.operation_id)::int AS remedied
      FROM days AS d
      LEFT JOIN blocked AS b ON b.date = d.date
      LEFT JOIN remedied AS r
        ON r.session_id = b.session_id AND r.operation_id = b.operation_id
      GROUP BY d.date
      ORDER BY d.date
    `);
    return result.rows.map((row) => ({
      date: row.date,
      blocked: Number(row.blocked),
      remedied: Number(row.remedied),
    }));
  }
}

export default OpenAppaOperationModel;
