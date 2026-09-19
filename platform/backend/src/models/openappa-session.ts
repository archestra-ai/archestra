import { and, eq, inArray, isNotNull, type SQL, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  clientSessionId,
  openappaActor,
  scopedSessionId,
} from "@/openappa/actor";

const table = schema.openappaSessionsTable;

/**
 * Read-only lineage over the OpenAPPA runtime's session records. The native
 * runtime writes every row; the proxy reads them to place a new session that
 * replays another session's history.
 */
class OpenAppaSessionModel {
  /** A caller-scoped session's record, or null before its first event. */
  static async find(params: { organizationId: string; sessionId: string }) {
    const [row] = await db
      .select({ sessionId: table.sessionId, forkedFrom: table.forkedFrom })
      .from(table)
      .where(
        and(
          eq(table.actor, openappaActor(params.sessionId)),
          eq(table.organizationId, params.organizationId),
        ),
      );
    return row ?? null;
  }

  /** Caller-scoped sessions whose native runtime roots have started. */
  static async startedSessionIds(params: {
    organizationId: string;
    sessionIds: readonly string[];
  }): Promise<Set<string>> {
    if (params.sessionIds.length === 0) return new Set();
    const rows = await db
      .select({ sessionId: table.sessionId })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          inArray(table.actor, params.sessionIds.map(openappaActor)),
        ),
      );
    return new Set(rows.map((row) => row.sessionId));
  }

  /** The sessions this one forks, nearest first: its parent, then that parent's, and on up. */
  static async forkLine(params: {
    organizationId: string;
    sessionId: string;
  }): Promise<string[]> {
    const line = await db.execute(sql`
      WITH RECURSIVE fork_line(forked_from, depth, visited) AS (
        SELECT forked_from, 1, ARRAY[session_id]::text[]
        FROM ${table}
        WHERE actor = ${openappaActor(params.sessionId)}
          AND organization_id = ${params.organizationId}
        UNION ALL
        SELECT parent.forked_from, line.depth + 1, line.visited || parent.session_id
        FROM fork_line AS line
        JOIN ${table} AS parent
          ON parent.session_id = line.forked_from
          AND parent.organization_id = ${params.organizationId}
        WHERE line.forked_from IS NOT NULL
          AND line.depth < ${MAX_FORK_DEPTH}
          AND NOT parent.session_id = ANY(line.visited)
      )
      SELECT forked_from AS "forkedFrom"
      FROM fork_line
      WHERE forked_from IS NOT NULL
    `);
    return (line.rows as Array<{ forkedFrom: string }>).map(
      (row) => row.forkedFrom,
    );
  }

  /**
   * A logged session's fork lineage, by the client's own session id: the
   * session it forks and the sessions forked from it, as client ids. Narrowed
   * to one caller's sessions when `callerId` is given.
   */
  static async lineage(params: {
    organizationId: string;
    clientSessionId: string;
    callerId?: string;
  }): Promise<{ forkedFrom: string | null; forks: string[] }> {
    const scoped = params.callerId
      ? scopedSessionId(params.callerId, params.clientSessionId)
      : undefined;
    const [own] = await db
      .select({ sessionId: table.sessionId, forkedFrom: table.forkedFrom })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          scoped
            ? eq(table.actor, openappaActor(scoped))
            : eq(clientId(table.sessionId), params.clientSessionId),
        ),
      )
      .limit(1);
    if (!own) return { forkedFrom: null, forks: [] };
    const forks = await db
      .select({ sessionId: table.sessionId })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          isNotNull(table.forkedFrom),
          eq(table.forkedFrom, own.sessionId),
        ),
      )
      .limit(MAX_LISTED_FORKS);
    return {
      forkedFrom: own.forkedFrom ? clientSessionId(own.forkedFrom) : null,
      forks: forks.map((fork) => clientSessionId(fork.sessionId)),
    };
  }
}

/** The client's own id inside a caller-scoped session id (`<caller>|<id>`). */
function clientId(
  column: typeof table.sessionId | typeof table.forkedFrom,
): SQL {
  return sql`substr(${column}, strpos(${column}, '|') + 1)`;
}

/** A session page lists at most this many forks. */
const MAX_LISTED_FORKS = 100;

/** Matches the native binding's bound on how far up a fork line it looks. */
const MAX_FORK_DEPTH = 32;

export default OpenAppaSessionModel;
