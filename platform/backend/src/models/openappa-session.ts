import {
  and,
  desc,
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
import { openPlainJson, openPlainText } from "@/openappa/plaintext-envelope";
import { mintReceiptCode } from "@/openappa/session-token";
import { ApiError } from "@/types";
import { isUniqueConstraintError } from "@/utils/db";

const table = schema.openappaSessionsTable;

/**
 * Lineage queries and session-receipt tokens for OpenAPPA runtime records.
 * The native runtime owns session rows. The host also retains immutable
 * identity indexes and receipts in the shared operations ledger.
 */
class OpenAppaSessionModel {
  /**
   * Bind an observed native Grok ID after verified child admission. Resuming a
   * transcript changes its native ID while retaining the governed actor.
   * This index contains identity only, never a message body or authorization.
   */
  static async retainGrokChildIdentity(params: {
    organizationId: string;
    callerId?: string;
    parentId: string;
    childSessionId: string;
    nativeId: string;
  }): Promise<void> {
    const existing = await OpenAppaSessionModel.grokChildIdentity(params);
    if (existing) {
      if (existing !== params.childSessionId)
        throw new ApiError(409, "Grok native child identity is already bound.");
      return;
    }
    const operations = schema.openappaOperationsTable;
    await db.execute(sql`
      INSERT INTO ${operations} (organization_id, session_id, caller_id, root, operation_id, status, input, decision)
      SELECT child.organization_id, child.parent_id, child.caller_id, child.root,
        ${`grok-child-identity:${params.nativeId}`}, 'complete',
        ${JSON.stringify({ childSessionId: params.childSessionId })}::jsonb,
        '{"decision":"ack"}'::jsonb
      FROM ${table} AS child
      WHERE child.organization_id = ${params.organizationId}
        AND child.session_id = ${params.childSessionId}
        AND child.parent_id = ${params.parentId}
        AND child.caller_id IS NOT DISTINCT FROM ${params.callerId ?? null}
      ON CONFLICT DO NOTHING
    `);
    const retained = await OpenAppaSessionModel.grokChildIdentity(params);
    if (retained && retained !== params.childSessionId)
      throw new ApiError(409, "Grok native child identity is already bound.");
  }

  static async grokChildIdentity(params: {
    organizationId: string;
    callerId?: string;
    parentId: string;
    nativeId: string;
  }): Promise<string | undefined> {
    const operations = schema.openappaOperationsTable;
    const rows = await db.execute<{ childSessionId: string }>(sql`
      SELECT child.session_id AS "childSessionId"
      FROM ${operations} AS binding
      JOIN ${table} AS child
        ON child.organization_id = binding.organization_id
        AND child.root = binding.root
        AND child.parent_id = binding.session_id
        AND child.caller_id IS NOT DISTINCT FROM binding.caller_id
        AND child.session_id = binding.input->>'childSessionId'
      WHERE binding.organization_id = ${params.organizationId}
        AND binding.session_id = ${params.parentId}
        AND binding.caller_id IS NOT DISTINCT FROM ${params.callerId ?? null}
        AND binding.operation_id = ${`grok-child-identity:${params.nativeId}`}
        AND binding.status = 'complete'
      LIMIT 2
    `);
    return rows.rows.length === 1 ? rows.rows[0].childSessionId : undefined;
  }

  /** Immutable host receipt, indexed by the existing session/operation key. */
  static async retainChildBinding(params: {
    session: {
      organization_id: string;
      session_id: string;
      caller_id?: string;
    };
    digest: string;
    footer: string;
  }): Promise<void> {
    const operations = schema.openappaOperationsTable;
    const { session, digest, footer } = params;
    await db.execute(sql`
      INSERT INTO ${operations} (organization_id, session_id, caller_id, root, operation_id, status, input, decision)
      SELECT organization_id, session_id, caller_id, root,
        ${`host-child-binding:${digest}`}, 'complete',
        ${JSON.stringify({ event: "host_child_binding", footer })}::jsonb, '{"decision":"ack"}'::jsonb
      FROM ${table}
      WHERE organization_id = ${session.organization_id}
        AND session_id = ${session.session_id}
        AND caller_id IS NOT DISTINCT FROM ${session.caller_id ?? null}
      ON CONFLICT DO NOTHING
    `);
    const retained = await OpenAppaSessionModel.childBinding({
      organizationId: session.organization_id,
      sessionId: session.session_id,
      callerId: session.caller_id,
      digest,
    });
    if (retained !== footer)
      throw new ApiError(503, "OpenAPPA could not retain the child binding");
  }

  static async childBinding(params: {
    organizationId: string;
    sessionId: string;
    callerId?: string;
    digest: string;
  }): Promise<string | undefined> {
    const operations = schema.openappaOperationsTable;
    const [row] = await db
      .select({
        footer: sql<string>`${operations.input}->>'footer'`,
      })
      .from(operations)
      .where(
        and(
          eq(operations.organizationId, params.organizationId),
          eq(operations.sessionId, params.sessionId),
          params.callerId
            ? eq(operations.callerId, params.callerId)
            : isNull(operations.callerId),
          eq(operations.operationId, `host-child-binding:${params.digest}`),
          eq(operations.status, "complete"),
          sql`${operations.input}->>'event' = 'host_child_binding'`,
        ),
      )
      .limit(1);
    return typeof row?.footer === "string" ? row.footer : undefined;
  }

  /** Reads retained bytes only for their authenticated recipient after enforcement is waived. */
  static async waivedPeerBody(params: {
    organizationId: string;
    callerId: string;
    sessionId: string;
    parentId?: string;
    messageId: string;
  }): Promise<string | null> {
    const peer = schema.openappaEmbeddedPeerMessagesTable;
    const [row] = await db
      .select({ body: peer.body })
      .from(peer)
      .innerJoin(
        table,
        and(
          eq(table.root, peer.root),
          sql`${peer.recipient} = CASE WHEN ${table.parentId} IS NULL THEN ${table.root} ELSE ${table.actor} END`,
        ),
      )
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(table.callerId, params.callerId),
          eq(table.sessionId, params.sessionId),
          params.parentId
            ? eq(table.parentId, params.parentId)
            : isNull(table.parentId),
          eq(peer.id, params.messageId),
          sql`${peer.expiresAt} > ${Math.floor(Date.now() / 1000)}`,
        ),
      )
      .limit(1);
    return row?.body ?? null;
  }

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

  /**
   * The session row a runtime trajectory belongs to: a child's trajectory is
   * its actor, a root session's trajectory is the root itself. Null when no
   * row, or more than one, matches.
   */
  static async findByTrajectory(params: { root: string; trajectory: string }) {
    const rows = await db
      .select({
        organizationId: table.organizationId,
        sessionId: table.sessionId,
        callerId: table.callerId,
      })
      .from(table)
      .where(
        and(
          eq(table.root, params.root),
          params.trajectory === params.root
            ? isNull(table.parentId)
            : eq(table.actor, params.trajectory),
        ),
      )
      .limit(2);
    return rows.length === 1 ? rows[0] : null;
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
    sessionId: string;
    mint?: () => string;
  }): Promise<{ token: string; receiptIssuedAt: Date | null } | null> {
    const mint = params.mint ?? mintReceiptCode;
    for (let attempt = 0; attempt < MAX_RECEIPT_MINT_ATTEMPTS; attempt++) {
      const token = mint();
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

  /** Retained denial for an offer, including expired or already resolved offers. */
  static async recordedOfferDecisions(params: {
    organizationId: string;
    sessionId: string;
    callerId: string;
    parentId?: string;
    offerId: string;
  }): Promise<Array<{ operationId: string; decision: unknown }>> {
    const operations = schema.openappaOperationsTable;
    const rows = await db
      .select({
        operationId: operations.operationId,
        decision: operations.decision,
      })
      .from(operations)
      .innerJoin(
        table,
        and(
          eq(table.organizationId, operations.organizationId),
          eq(table.sessionId, operations.sessionId),
          eq(table.root, operations.root),
        ),
      )
      .where(
        and(
          eq(operations.organizationId, params.organizationId),
          eq(operations.sessionId, params.sessionId),
          eq(operations.callerId, params.callerId),
          eq(table.callerId, params.callerId),
          params.parentId
            ? eq(table.parentId, params.parentId)
            : isNull(table.parentId),
          eq(operations.status, "complete"),
          // Encrypted and plaintext-escaped receipts must be opened by the
          // native storage cipher before their offers can be inspected.
          sql`(${operations.decision}->'offers' @> ${JSON.stringify([{ offer_id: params.offerId }])}::jsonb OR ${operations.decision} ? '__appa_encrypted')`,
        ),
      )
      .orderBy(desc(operations.createdAt))
      .limit(10_001);
    if (rows.length > 10_000) {
      throw new ApiError(
        503,
        "OpenAPPA offer lookup exceeds the retained receipt budget",
      );
    }
    return rows;
  }

  /** Call rulings recorded by this exact session, never inherited fork history. */
  static async recordedToolCallDecisions(params: {
    organizationId: string;
    sessionId: string;
    callerId?: string;
    parentId?: string;
    toolCallIds: readonly string[];
  }): Promise<Map<string, unknown>> {
    const calls = await OpenAppaSessionModel.recordedToolCalls(params);
    return new Map([...calls].map(([id, call]) => [id, call.decision]));
  }

  /** Scoped runtime receipts; original inputs are read only when history needs restoration. */
  static async recordedToolCalls(params: {
    organizationId: string;
    sessionId: string;
    callerId?: string;
    parentId?: string;
    toolCallIds: readonly string[];
    includeInput?: boolean;
  }): Promise<Map<string, { decision: unknown; input?: unknown }>> {
    if (params.toolCallIds.length === 0) return new Map();
    const operations = schema.openappaOperationsTable;
    const rows = await db
      .select({
        operationId: operations.operationId,
        decision: operations.decision,
        input: params.includeInput ? operations.input : sql<null>`NULL`,
      })
      .from(operations)
      .innerJoin(
        table,
        and(
          eq(table.organizationId, operations.organizationId),
          eq(table.sessionId, operations.sessionId),
          eq(table.root, operations.root),
        ),
      )
      .where(
        and(
          eq(operations.organizationId, params.organizationId),
          eq(operations.sessionId, params.sessionId),
          params.callerId
            ? and(
                eq(operations.callerId, params.callerId),
                eq(table.callerId, params.callerId),
              )
            : and(isNull(operations.callerId), isNull(table.callerId)),
          params.parentId
            ? eq(table.parentId, params.parentId)
            : isNull(table.parentId),
          inArray(
            operations.operationId,
            params.toolCallIds.flatMap((id) => [
              `call:${id}`,
              `peer-read-call:${id}`,
            ]),
          ),
          eq(operations.status, "complete"),
          sql`COALESCE(${operations.input}->'semantic'->>'event', ${operations.input}->>'event') = 'tool_call'`,
        ),
      );
    return new Map(
      rows.map((row) => [
        row.operationId.replace(/^(?:peer-read-)?call:/, ""),
        {
          decision: openPlainJson(row.decision),
          ...(params.includeInput ? { input: openPlainJson(row.input) } : {}),
        },
      ]),
    );
  }

  /**
   * Maps each requested offer id to the operation id of the denied call that
   * issued it in this session. Sibling offers of one denied call share the
   * same operation id.
   */
  static async deniedCallOperationsByOfferId(params: {
    organizationId: string;
    sessionId: string;
    callerId?: string;
    parentId?: string;
    offerIds: readonly string[];
  }): Promise<Map<string, string>> {
    if (params.offerIds.length === 0) return new Map();
    const wanted = new Set(params.offerIds);
    const operations = schema.openappaOperationsTable;
    const rows = await db
      .select({
        operationId: operations.operationId,
        decision: operations.decision,
      })
      .from(operations)
      .innerJoin(
        table,
        and(
          eq(table.organizationId, operations.organizationId),
          eq(table.sessionId, operations.sessionId),
          eq(table.root, operations.root),
        ),
      )
      .where(
        and(
          eq(operations.organizationId, params.organizationId),
          eq(operations.sessionId, params.sessionId),
          params.callerId
            ? and(
                eq(operations.callerId, params.callerId),
                eq(table.callerId, params.callerId),
              )
            : and(isNull(operations.callerId), isNull(table.callerId)),
          params.parentId
            ? eq(table.parentId, params.parentId)
            : isNull(table.parentId),
          eq(operations.status, "complete"),
        ),
      );
    const result = new Map<string, string>();
    for (const row of rows) {
      const decision = openPlainJson(row.decision);
      if (!decision || typeof decision !== "object") continue;
      const offers = (decision as { offers?: unknown }).offers;
      if (!Array.isArray(offers)) continue;
      for (const offer of offers) {
        if (!offer || typeof offer !== "object") continue;
        const offerId = (offer as { offer_id?: unknown }).offer_id;
        if (typeof offerId === "string" && wanted.has(offerId)) {
          result.set(offerId, row.operationId);
        }
      }
    }
    return result;
  }

  /**
   * Completed results already governed in this exact trajectory. A client may
   * omit their bytes from old history without creating a new return crossing.
   * Read IDs only: checking an omission must not reload the pruned output.
   */
  static async completedToolResultIds(params: {
    organizationId: string;
    sessionId: string;
    callerId?: string;
    parentId?: string;
    toolCallIds: readonly string[];
  }): Promise<Set<string>> {
    if (params.toolCallIds.length === 0) return new Set();
    const results = schema.openappaProcessedResultsTable;
    const rows = await db
      .select({ toolCallId: results.toolCallId })
      .from(results)
      .innerJoin(
        table,
        and(
          eq(table.organizationId, results.organizationId),
          eq(table.sessionId, results.sessionId),
          eq(table.root, results.root),
        ),
      )
      .where(
        and(
          eq(results.organizationId, params.organizationId),
          eq(results.sessionId, params.sessionId),
          params.callerId
            ? and(
                eq(results.callerId, params.callerId),
                eq(table.callerId, params.callerId),
              )
            : and(isNull(results.callerId), isNull(table.callerId)),
          params.parentId
            ? eq(table.parentId, params.parentId)
            : isNull(table.parentId),
          inArray(results.toolCallId, [...params.toolCallIds]),
          eq(results.status, "complete"),
        ),
      );
    return new Set(rows.map((row) => row.toolCallId));
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
    return openPlainText(row?.approvedOutput ?? null);
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
    return peerReadReceipt(
      openPlainJson(row?.decision),
      openPlainText(row?.approvedOutput ?? null),
    );
  }

  /**
   * The sessions of a root's family whose own client-native id is
   * `nativeId`. A child at any depth counts; the root does not.
   */
  static async familyMembersByNativeId(params: {
    organizationId: string;
    rootSessionId: string;
    nativeId: string;
  }): Promise<Array<{ sessionId: string; parentId: string | null }>> {
    const [root] = await db
      .select({ root: table.root })
      .from(table)
      .where(
        and(
          eq(table.actor, openappaActor(params.rootSessionId)),
          eq(table.organizationId, params.organizationId),
          isNull(table.parentId),
        ),
      )
      .limit(1);
    if (!root) return [];
    // A child's own id is all of its id after its parent's and a colon; an
    // id can itself hold a colon, so the parent decides where it starts.
    return db
      .select({ sessionId: table.sessionId, parentId: table.parentId })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(table.root, root.root),
          sql`starts_with(${table.sessionId}, ${`${params.rootSessionId}:`})`,
          sql`${table.sessionId} = ${table.parentId} || ${`:${params.nativeId}`}`,
        ),
      )
      .limit(2);
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
   * The client session id that opened a root: the session at the top of the
   * family, which sub-agents' trajectories share the root of.
   */
  static async rootClientSessionId(params: {
    organizationId: string;
    root: string;
  }): Promise<string | null> {
    const [row] = await db
      .select({ sessionId: table.sessionId })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(table.root, params.root),
          isNull(table.parentId),
        ),
      )
      .limit(1);
    return row ? clientSessionId(row.sessionId) : null;
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
        `OpenAPPA session lineage is ambiguous because multiple authenticated callers used session ID "${params.clientSessionId}"`,
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
