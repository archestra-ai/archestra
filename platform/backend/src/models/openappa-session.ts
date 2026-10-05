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
  static async hasAncestor(params: {
    organizationId: string;
    callerId: string;
    sessionId: string;
    ancestorSessionId: string;
  }): Promise<boolean> {
    const result = await db.execute<{ present: boolean }>(sql`
      WITH RECURSIVE lineage AS (
        SELECT session_id, parent_id, ARRAY[session_id]::text[] AS visited
        FROM ${table}
        WHERE organization_id = ${params.organizationId}
          AND caller_id = ${params.callerId} AND session_id = ${params.sessionId}
        UNION ALL
        SELECT s.session_id, s.parent_id, lineage.visited || s.session_id
        FROM ${table} AS s JOIN lineage ON s.session_id = lineage.parent_id
        WHERE s.organization_id = ${params.organizationId}
          AND s.caller_id = ${params.callerId}
          AND NOT s.session_id = ANY(lineage.visited)
          AND cardinality(lineage.visited) < 64
      )
      SELECT EXISTS(SELECT 1 FROM lineage WHERE session_id = ${params.ancestorSessionId}) AS present
    `);
    return result.rows[0]?.present === true;
  }

  /** Stored parent of a session row. Null before the first event or when unbound. */
  static async parentId(params: {
    organizationId: string;
    sessionId: string;
  }): Promise<string | null> {
    const [row] = await db
      .select({ parentId: table.parentId })
      .from(table)
      .where(
        and(
          eq(table.actor, openappaActor(params.sessionId)),
          eq(table.organizationId, params.organizationId),
        ),
      )
      .limit(1);
    return row?.parentId ?? null;
  }

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
  }): Promise<{ token: string; receiptIssuedAt: Date | null } | null> {
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
          .returning({
            receiptToken: table.receiptToken,
            receiptIssuedAt: table.receiptIssuedAt,
          });
        if (assigned?.receiptToken) {
          return {
            token: assigned.receiptToken,
            receiptIssuedAt: assigned.receiptIssuedAt ?? null,
          };
        }
        // No row updated: the session row is missing, or a concurrent writer
        // already assigned its token — read once to tell the two apart.
        const raced = await OpenAppaSessionModel.find({
          organizationId: params.organizationId,
          sessionId: params.sessionId,
        });
        if (!raced?.receiptToken) return null;
        return {
          token: raced.receiptToken,
          receiptIssuedAt: raced.receiptIssuedAt ?? null,
        };
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
   * The persisted session, including its parent. Callers must not rebuild a
   * parent object that drops `parentId`: the runtime treats that as a
   * different session.
   */
  static async familySession(params: {
    organizationId: string;
    sessionId: string;
    callerId?: string;
  }): Promise<{
    sessionId: string;
    parentId: string | null;
    callerId: string | null;
  } | null> {
    const [row] = await db
      .select({
        sessionId: table.sessionId,
        parentId: table.parentId,
        callerId: table.callerId,
      })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(table.sessionId, params.sessionId),
          params.callerId
            ? eq(table.callerId, params.callerId)
            : isNull(table.callerId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * The journaled output of a tool result the runtime already recorded.
   * A client echo is delivered only when it matches this text.
   */
  static async retainedToolResult(params: {
    organizationId: string;
    sessionId: string;
    callerId?: string;
    toolCallId: string;
  }): Promise<string | null> {
    const results = schema.openappaProcessedResultsTable;
    const [row] = await db
      .select({ approvedOutput: results.approvedOutput })
      .from(results)
      .where(
        and(
          eq(results.organizationId, params.organizationId),
          eq(results.sessionId, params.sessionId),
          eq(results.toolCallId, params.toolCallId),
          eq(results.status, "complete"),
          params.callerId
            ? eq(results.callerId, params.callerId)
            : isNull(results.callerId),
        ),
      )
      .limit(1);
    return row?.approvedOutput ?? null;
  }

  /**
   * The trusted peer-read receipt for one tool call. A denial carries the
   * runtime feedback and offer ids and no message body. An admission carries
   * the retained body. Client JSON is not a receipt.
   */
  static async retainedPeerReadReceipt(params: {
    organizationId: string;
    sessionId: string;
    callerId?: string;
    toolCallId: string;
  }): Promise<RetainedPeerReadReceipt | null> {
    const results = schema.openappaProcessedResultsTable;
    const [row] = await db
      .select({
        decision: results.decision,
        approvedOutput: results.approvedOutput,
      })
      .from(results)
      .where(
        and(
          eq(results.organizationId, params.organizationId),
          eq(results.sessionId, params.sessionId),
          eq(results.toolCallId, params.toolCallId),
          eq(results.status, "complete"),
          params.callerId
            ? eq(results.callerId, params.callerId)
            : isNull(results.callerId),
        ),
      )
      .limit(1);
    return peerReadReceipt(row?.decision, row?.approvedOutput ?? null);
  }

  /**
   * The client-native ids of the children a session started, such as a lead's
   * teammates. A child session id is its parent's id, a colon, and the id the
   * client gave the child.
   */
  static async childNativeIds(params: {
    organizationId: string;
    parentSessionId: string;
  }): Promise<string[]> {
    const prefix = `${params.parentSessionId}:`;
    const rows = await db
      .select({ sessionId: table.sessionId })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(table.parentId, params.parentSessionId),
        ),
      );
    return rows
      .map((row) => row.sessionId)
      .filter((sessionId) => sessionId.startsWith(prefix))
      .map((sessionId) => sessionId.slice(prefix.length));
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

type RetainedPeerReadReceipt =
  | {
      kind: "denied";
      feedback: string;
      offers: Array<{ offer_id: string }>;
    }
  | { kind: "admitted"; approvedOutput: string };

function peerReadReceipt(
  decision: unknown,
  approvedOutput: string | null,
): RetainedPeerReadReceipt | null {
  if (!decision || typeof decision !== "object") return null;
  const record = decision as Record<string, unknown>;
  if (record.peer_read_denied === true) {
    const feedback =
      typeof record.feedback === "string"
        ? record.feedback
        : (approvedOutput ?? "");
    if (record.value !== undefined || record.result !== undefined) return null;
    const offers = Array.isArray(record.offers)
      ? record.offers.flatMap((offer) => {
          if (!offer || typeof offer !== "object") return [];
          const id = (offer as { offer_id?: unknown }).offer_id;
          return typeof id === "string" && id.length > 0
            ? [{ offer_id: id }]
            : [];
        })
      : [];
    return { kind: "denied", feedback, offers };
  }
  if (
    record.peer_read === true &&
    typeof approvedOutput === "string" &&
    approvedOutput.length > 0
  ) {
    return { kind: "admitted", approvedOutput };
  }
  return null;
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
