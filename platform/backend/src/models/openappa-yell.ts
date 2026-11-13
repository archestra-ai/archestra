import {
  and,
  count,
  desc,
  eq,
  exists,
  getTableColumns,
  ilike,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import db, { type Transaction } from "@/database";
import conversationsTable, {
  notDeletedConversation,
} from "@/database/schemas/conversation";
import { openappaYellsTable as table } from "@/database/schemas/openappa-yell";
import {
  createCursorPaginatedResult,
  decodeCursor,
} from "@/database/utils/pagination";
import type {
  InsertOpenAppaYell,
  OpenAppaYellKind,
  OpenAppaYellQuery,
} from "@/types/openappa-yell";
import { normalizeByteaField } from "@/utils/normalize-bytea";

/**
 * The yells a read may reach: the organization's, narrowed to one caller's
 * (such as `user:<id>`) when `callerId` is set.
 */
type YellScope = { organizationId: string; callerId?: string };

export default class OpenAppaYellModel {
  static async findByIdForAudit(id: string, organizationId: string) {
    const row = await OpenAppaYellModel.find({ id, organizationId });
    return row
      ? { resolvedAt: row.resolvedAt, resolvedBy: row.resolvedBy }
      : null;
  }

  static async record(input: InsertOpenAppaYell) {
    const [row] = await db
      .insert(table)
      .values(input)
      .onConflictDoNothing()
      .returning(metadataColumns());
    if (row) return row;
    const [existing] = await db
      .select(metadataColumns())
      .from(table)
      .where(
        and(
          eq(table.organizationId, input.organizationId),
          eq(table.callerId, input.callerId),
          eq(table.sessionId, input.sessionId),
          eq(table.toolCallId, input.toolCallId),
        ),
      );
    if (!existing) throw new Error("Could not record OpenAPPA yell");
    return existing;
  }

  /**
   * Records calls the platform let through under the Break the glass
   * settings. Repeats of the same tool and kind in a session add to one
   * unresolved yell, so a looping agent does not flood the Yells tab; once
   * resolved, the next repeat raises it again as a new yell. Release 1.4 keeps
   * no count: `calls` is accepted for the callers' sake and not stored.
   */
  static async recordWaiver(
    input: {
      organizationId: string;
      callerId: string;
      sessionId: string;
      kind: Exclude<OpenAppaYellKind, "agent">;
      tool: string;
      message: string;
      superyell: boolean;
      calls?: number;
    },
    executor: typeof db | Transaction = db,
  ) {
    await executor
      .insert(table)
      .values({
        organizationId: input.organizationId,
        callerId: input.callerId,
        sessionId: input.sessionId,
        // Not a call id: the key repeats merge under.
        toolCallId: `${input.kind}:${input.tool}`,
        message: input.message,
        withTrajectory: false,
        superyell: input.superyell,
      })
      .onConflictDoUpdate({
        target: [
          table.organizationId,
          table.callerId,
          table.sessionId,
          table.toolCallId,
        ],
        // A resolved yell is raised again as a new one: its count and age
        // start over, so the Yells tab lists it as new.
        set: {
          createdAt: sql`case when ${table.resolvedAt} is null then ${table.createdAt} else now() end`,
          message: input.message,
          superyell: input.superyell,
          resolvedAt: null,
          resolvedBy: null,
        },
      });
  }

  static async storeArchive(params: {
    id: string;
    organizationId: string;
    archive: Buffer;
  }) {
    await db
      .update(table)
      .set({ archive: params.archive })
      .where(
        and(
          eq(table.id, params.id),
          eq(table.organizationId, params.organizationId),
          isNull(table.archive),
        ),
      );
  }

  static async findArchive(params: YellScope & { id: string }) {
    const [row] = await db
      .select({ archive: table.archive })
      .from(table)
      .where(
        and(
          eq(table.id, params.id),
          eq(table.organizationId, params.organizationId),
          callerCondition(params),
        ),
      );
    return row ? normalizeByteaField(row, "archive").archive : null;
  }

  static async recordDelivery(params: {
    id: string;
    organizationId: string;
    failed: boolean;
  }) {
    await db
      .update(table)
      .set({
        reportFailed: params.failed,
        reportedAt: params.failed ? null : new Date(),
      })
      .where(
        and(
          eq(table.id, params.id),
          eq(table.organizationId, params.organizationId),
        ),
      );
  }

  static async find(params: YellScope & { id: string }) {
    const [row] = await db
      .select(metadataColumns())
      .from(table)
      .where(
        and(
          eq(table.id, params.id),
          eq(table.organizationId, params.organizationId),
          callerCondition(params),
        ),
      );
    return row ?? null;
  }

  static async summary(params: YellScope) {
    const [row] = await db
      .select({
        unresolved: count(),
        superyells:
          sql<number>`count(*) filter (where ${table.superyell})`.mapWith(
            Number,
          ),
      })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          callerCondition(params),
          isNull(table.resolvedAt),
        ),
      );
    return {
      unresolved: row?.unresolved ?? 0,
      superyells: row?.superyells ?? 0,
    };
  }

  static async list(
    params: OpenAppaYellQuery & YellScope & { sessionId?: string },
  ) {
    const position = decodeCursor(params.cursor);
    const validCursor =
      position &&
      z.uuid().safeParse(position.id).success &&
      !Number.isNaN(Date.parse(position.value));
    const rows = await db
      .select(metadataColumns())
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          callerCondition(params),
          params.status === "unresolved"
            ? isNull(table.resolvedAt)
            : params.status === "resolved"
              ? isNotNull(table.resolvedAt)
              : undefined,
          params.sessionId ? eq(table.sessionId, params.sessionId) : undefined,
          // OpenAPPA's session id is the caller scope, `|`, then the client's
          // own session id, which is the LLM session id.
          params.llmSessionId
            ? sql`substr(${table.sessionId}, strpos(${table.sessionId}, '|') + 1) = ${params.llmSessionId}`
            : undefined,
          params.search
            ? ilike(
                table.message,
                `%${params.search.replace(/[\\%_]/g, "\\$&")}%`,
              )
            : undefined,
          validCursor
            ? sql`(${table.createdAt}, ${table.id}) < (${position.value}::timestamptz, ${position.id}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(table.createdAt), desc(table.id))
      .limit(params.limit + 1);
    return createCursorPaginatedResult(rows, params, (row) => ({
      value: row.createdAt.toISOString(),
      id: row.id,
    }));
  }

  /** Links the yell to its investigation chat once; a later chat never replaces it. */
  static async linkConversation(params: {
    id: string;
    organizationId: string;
    conversationId: string;
  }) {
    await db
      .update(table)
      .set({ conversationId: params.conversationId })
      .where(
        and(
          eq(table.id, params.id),
          eq(table.organizationId, params.organizationId),
          isNull(table.conversationId),
          exists(
            db
              .select({ id: conversationsTable.id })
              .from(conversationsTable)
              .where(
                and(
                  eq(conversationsTable.id, params.conversationId),
                  eq(conversationsTable.organizationId, params.organizationId),
                ),
              ),
          ),
        ),
      );
  }

  static async findConversations(params: {
    ids: string[];
    organizationId: string;
    userId: string;
  }) {
    if (params.ids.length === 0) return [];
    return db
      .select({
        yellId: table.id,
        id: conversationsTable.id,
        title: conversationsTable.title,
        createdAt: conversationsTable.createdAt,
      })
      .from(table)
      .innerJoin(
        conversationsTable,
        and(
          eq(conversationsTable.id, table.conversationId),
          notDeletedConversation,
          eq(conversationsTable.organizationId, params.organizationId),
          eq(conversationsTable.userId, params.userId),
        ),
      )
      .where(
        and(
          inArray(table.id, params.ids),
          eq(table.organizationId, params.organizationId),
        ),
      );
  }

  static async setResolved(
    params: YellScope & {
      id: string;
      userId: string;
      resolved: boolean;
    },
  ) {
    const [row] = await db
      .update(table)
      .set({
        resolvedAt: params.resolved ? new Date() : null,
        resolvedBy: params.resolved ? params.userId : null,
      })
      .where(
        and(
          eq(table.id, params.id),
          eq(table.organizationId, params.organizationId),
          callerCondition(params),
        ),
      )
      .returning(metadataColumns());
    return row ?? null;
  }
}

function callerCondition(scope: YellScope) {
  return scope.callerId === undefined
    ? undefined
    : eq(table.callerId, scope.callerId);
}

function metadataColumns() {
  const { archive, conversationId, ...columns } = getTableColumns(table);
  return {
    ...columns,
    hasArchive: sql<boolean>`${archive} IS NOT NULL`,
    // Release 1.4 has no kind column: a platform yell's merge key starts with
    // its kind (`recordWaiver`), an agent's own yell carries a real call id.
    kind: sql<OpenAppaYellKind>`case when ${columns.toolCallId} like 'approval\_waived:%' then 'approval_waived' when ${columns.toolCallId} like 'block\_waived:%' then 'block_waived' else 'agent' end`,
    // Nor a count column: each yell stands for one record on 1.4.
    count: sql<number>`1`.mapWith(Number),
  };
}
