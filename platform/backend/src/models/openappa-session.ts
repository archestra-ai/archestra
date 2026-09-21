import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import db, { schema } from "@/database";
import logger from "@/logging";
import {
  clientSessionId,
  openappaActor,
  scopedSessionId,
} from "@/openappa/actor";
import { mintReceiptCode } from "@/openappa/session-token";
import { ApiError } from "@/types";
import { isUniqueConstraintError } from "@/utils/db";

const table = schema.openappaSessionsTable;

/**
 * Lineage queries and session-receipt tokens for OpenAPPA runtime records.
 * The native runtime writes every row. The proxy reads these rows to
 * attach a new session to an existing history.
 */
class OpenAppaSessionModel {
  /** Returns a caller-scoped session record, or null before its first event. */
  static async find(params: { organizationId: string; sessionId: string }) {
    const [row] = await db
      .select({
        sessionId: table.sessionId,
        forkedFrom: table.forkedFrom,
        receiptToken: table.receiptToken,
        receiptIssuedAt: table.receiptIssuedAt,
      })
      .from(table)
      .where(
        and(
          eq(table.actor, openappaActor(params.sessionId)),
          eq(table.organizationId, params.organizationId),
        ),
      );
    return row ?? null;
  }

  static async ensureReceiptToken(params: {
    organizationId: string;
    callerId: string;
    sessionId: string;
    secret: string;
  }): Promise<string | null> {
    for (let attempt = 0; attempt < MAX_RECEIPT_MINT_ATTEMPTS; attempt++) {
      const token = mintReceiptCode({
        secret: params.secret,
        organizationId: params.organizationId,
        callerId: params.callerId,
        sessionId: params.sessionId,
        collision: attempt,
      });
      try {
        const [assigned] = await db
          .update(table)
          .set({ receiptToken: token })
          .where(
            and(
              eq(table.actor, openappaActor(params.sessionId)),
              eq(table.organizationId, params.organizationId),
              isNull(table.receiptToken),
            ),
          )
          .returning({ receiptToken: table.receiptToken });
        if (assigned?.receiptToken) return assigned.receiptToken;
        // No row updated: the session row is missing, or a concurrent writer
        // already assigned its token — read once to tell the two apart.
        const raced = await OpenAppaSessionModel.find({
          organizationId: params.organizationId,
          sessionId: params.sessionId,
        });
        return raced?.receiptToken ?? null;
      } catch (error) {
        if (!isUniqueConstraintError(error)) throw error;
      }
    }

    logger.warn(
      {
        organizationId: params.organizationId,
        sessionId: params.sessionId,
      },
      "OpenAPPA could not assign a unique session receipt token",
    );
    return null;
  }

  static async receiptTokenOwner(params: {
    organizationId: string;
    token: string;
  }): Promise<{ sessionId: string; callerId: string } | null> {
    const [row] = await db
      .select({ sessionId: table.sessionId, callerId: table.callerId })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(table.receiptToken, params.token),
        ),
      );
    if (!row?.callerId) return null;
    return { sessionId: row.sessionId, callerId: row.callerId };
  }

  static async receiptTokenOwners(params: {
    organizationId: string;
    tokens: readonly string[];
  }): Promise<Map<string, { sessionId: string; callerId: string }>> {
    const owners = new Map<string, { sessionId: string; callerId: string }>();
    if (params.tokens.length === 0) return owners;
    const rows = await db
      .select({
        receiptToken: table.receiptToken,
        sessionId: table.sessionId,
        callerId: table.callerId,
      })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          inArray(table.receiptToken, [...params.tokens]),
        ),
      );
    for (const row of rows) {
      if (!row.receiptToken || !row.callerId) continue;
      owners.set(row.receiptToken, {
        sessionId: row.sessionId,
        callerId: row.callerId,
      });
    }
    return owners;
  }

  static async markReceiptIssued(params: {
    organizationId: string;
    sessionId: string;
  }): Promise<void> {
    await db
      .update(table)
      .set({ receiptIssuedAt: sql`now()` })
      .where(
        and(
          eq(table.actor, openappaActor(params.sessionId)),
          eq(table.organizationId, params.organizationId),
          isNull(table.receiptIssuedAt),
        ),
      );
  }

  /** Returns caller-scoped sessions whose native runtime roots have started. */
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

  /**
   * Finds fork ancestors for each supplied session, nearest first.
   * A recursive CTE keeps tool-stamp and session-receipt evidence coherent.
   */
  static async forkLines(params: {
    organizationId: string;
    sessionIds: readonly string[];
  }): Promise<Map<string, string[]>> {
    if (params.sessionIds.length === 0) return new Map();
    const line = await db.execute(sql`
      WITH RECURSIVE fork_line(source, forked_from, depth, visited) AS (
        SELECT session_id, forked_from, 1, ARRAY[session_id]::text[]
        FROM ${table}
        WHERE ${inArray(table.actor, params.sessionIds.map(openappaActor))}
          AND organization_id = ${params.organizationId}
        UNION ALL
        SELECT line.source, parent.forked_from, line.depth + 1, line.visited || parent.session_id
        FROM fork_line AS line
        JOIN ${table} AS parent
          ON parent.session_id = line.forked_from
          AND parent.organization_id = ${params.organizationId}
        WHERE line.forked_from IS NOT NULL
          AND line.depth < ${MAX_FORK_DEPTH}
          AND NOT parent.session_id = ANY(line.visited)
      )
      SELECT source, forked_from AS "forkedFrom"
      FROM fork_line
      WHERE forked_from IS NOT NULL
    `);
    const lines = new Map<string, string[]>();
    for (const row of line.rows as Array<{
      source: string;
      forkedFrom: string;
    }>) {
      lines.set(row.source, [...(lines.get(row.source) ?? []), row.forkedFrom]);
    }
    return lines;
  }

  /**
   * Returns fork lineage for a client session ID.
   * If callerId is provided, queries only sessions for that caller.
   * When callerId is omitted, the client session ID must resolve to exactly one caller.
   */
  static async lineage(params: {
    organizationId: string;
    clientSessionId: string;
    callerId?: string;
  }): Promise<{
    forkedFrom: string | null;
    forks: string[];
    forksTruncated: boolean;
  }> {
    const scoped = params.callerId
      ? scopedSessionId(params.callerId, params.clientSessionId)
      : undefined;
    const ownRows = await db
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
      // A second row is enough to reject an ambiguous admin lookup without
      // scanning every caller that used this client session id.
      .limit(scoped ? 1 : 2);
    if (!scoped && ownRows.length > 1) {
      throw new ApiError(
        409,
        `Session lineage is ambiguous because multiple authenticated callers used session ID "${params.clientSessionId}"`,
      );
    }
    const [own] = ownRows;
    if (!own) return { forkedFrom: null, forks: [], forksTruncated: false };
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
      .limit(MAX_LISTED_FORKS + 1);
    return {
      forkedFrom: own.forkedFrom ? clientSessionId(own.forkedFrom) : null,
      forks: forks
        .slice(0, MAX_LISTED_FORKS)
        .map((fork) => clientSessionId(fork.sessionId)),
      forksTruncated: forks.length > MAX_LISTED_FORKS,
    };
  }
}

/** Extracts the client ID from a caller-scoped session ID (`<caller>|<id>`). */
function clientId(
  column: typeof table.sessionId | typeof table.forkedFrom,
): SQL {
  return sql`substr(${column}, strpos(${column}, '|') + 1)`;
}

/** Maximum number of forks returned for a session. */
const MAX_LISTED_FORKS = 100;

const MAX_RECEIPT_MINT_ATTEMPTS = 3;

/** Maximum search depth along a fork line. Matches the native binding limit. */
const MAX_FORK_DEPTH = 32;

export default OpenAppaSessionModel;
