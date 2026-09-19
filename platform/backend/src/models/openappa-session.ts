import { and, eq, isNotNull, type SQL, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { openappaActor } from "@/openappa/actor";

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

  /** The sessions this one forks, nearest first: its parent, then that parent's, and on up. */
  static async forkLine(params: {
    organizationId: string;
    sessionId: string;
  }): Promise<string[]> {
    const line: string[] = [];
    let current = params.sessionId;
    while (line.length < MAX_FORK_DEPTH) {
      const row = await OpenAppaSessionModel.find({
        organizationId: params.organizationId,
        sessionId: current,
      });
      if (!row?.forkedFrom || line.includes(row.forkedFrom)) break;
      line.push(row.forkedFrom);
      current = row.forkedFrom;
    }
    return line;
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
    const caller = params.callerId ? [eq(table.callerId, params.callerId)] : [];
    const [own] = await db
      .select({ forkedFrom: table.forkedFrom })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(clientId(table.sessionId), params.clientSessionId),
          ...caller,
        ),
      )
      .limit(1);
    const forks = await db
      .select({ sessionId: table.sessionId })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          isNotNull(table.forkedFrom),
          eq(clientId(table.forkedFrom), params.clientSessionId),
          ...caller,
        ),
      )
      .limit(MAX_LISTED_FORKS);
    return {
      forkedFrom: own?.forkedFrom ? unscoped(own.forkedFrom) : null,
      forks: forks.map((fork) => unscoped(fork.sessionId)),
    };
  }
}

/** The client's own id inside a caller-scoped session id (`<caller>|<id>`). */
function clientId(
  column: typeof table.sessionId | typeof table.forkedFrom,
): SQL {
  return sql`substr(${column}, strpos(${column}, '|') + 1)`;
}

function unscoped(sessionId: string): string {
  const separator = sessionId.indexOf("|");
  return separator >= 0 ? sessionId.slice(separator + 1) : sessionId;
}

/** A session page lists at most this many forks. */
const MAX_LISTED_FORKS = 100;

/** Matches the native binding's bound on how far up a fork line it looks. */
const MAX_FORK_DEPTH = 32;

export default OpenAppaSessionModel;
