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
import {
  type InsertOpenAppaYell,
  type OpenAppaYellKind,
  OpenAppaYellKindSchema,
  type OpenAppaYellQuery,
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
   * resolved, the next repeat raises it again as a new yell. `calls` is how
   * many distinct calls this record stands for; the caller counts a call once.
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
    const calls = input.calls ?? 1;
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
        kind: input.kind,
        count: calls,
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
          count: sql`case when ${table.resolvedAt} is null then ${table.count} + ${calls} else ${calls} end`,
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

  /**
   * Unresolved waiver yells raised in `(since, until]`, per tool they name:
   * a waiver's key is `<kind>:<tool>`, its tool part possibly a
   * comma-separated list. Most yells first.
   */
  static async unresolvedWaiversByTool(params: {
    organizationId: string;
    since: Date;
    until: Date;
    limit: number;
    evidenceLimit: number;
  }) {
    const kinds: Exclude<OpenAppaYellKind, "agent">[] = [
      "approval_waived",
      "block_waived",
    ];
    const result = await db.execute(sql`
      WITH named AS (
        SELECT y.id, y.session_id, y.count, y.created_at, y.kind, btrim(t.tool) AS tool
        FROM ${table} AS y
        CROSS JOIN LATERAL regexp_split_to_table(
          substr(y.tool_call_id, strpos(y.tool_call_id, ':') + 1), ','
        ) AS t(tool)
        WHERE y.organization_id = ${params.organizationId}
          AND y.resolved_at IS NULL
          AND y.created_at > ${params.since.toISOString()}::timestamptz
          AND y.created_at <= ${params.until.toISOString()}::timestamptz
          AND y.kind IN (${sql.join(
            kinds.map((kind) => sql`${kind}`),
            sql`, `,
          )})
      ),
      ranked AS (
        SELECT named.*,
          ROW_NUMBER() OVER (PARTITION BY tool ORDER BY created_at DESC, id DESC) AS rn
        FROM named
        WHERE tool <> ''
      )
      SELECT tool,
        COUNT(DISTINCT id)::int AS yells,
        SUM(count)::int AS calls,
        COUNT(DISTINCT session_id)::int AS sessions,
        MIN(created_at) AS first_at,
        MAX(created_at) AS last_at,
        to_jsonb(ARRAY_AGG(DISTINCT kind)) AS kinds,
        COALESCE(to_jsonb((ARRAY_AGG(id::text ORDER BY created_at DESC, id DESC)
          FILTER (WHERE rn <= ${params.evidenceLimit}::int))[1:${params.evidenceLimit}::int]), '[]'::jsonb) AS recent_ids
      FROM ranked
      GROUP BY tool
      ORDER BY yells DESC, tool
      LIMIT ${params.limit}
    `);
    return UnresolvedWaiversByToolRowSchema.array().parse(result.rows);
  }

  /** Unresolved yells agents raised themselves in `(since, until]`, per caller. */
  static async unresolvedAgentYellsByCaller(params: {
    organizationId: string;
    since: Date;
    until: Date;
    limit: number;
    evidenceLimit: number;
  }) {
    const result = await db.execute(sql`
      WITH ranked AS (
        SELECT y.id, y.caller_id, y.session_id, y.created_at,
          ROW_NUMBER() OVER (PARTITION BY y.caller_id ORDER BY y.created_at DESC, y.id DESC) AS rn
        FROM ${table} AS y
        WHERE y.organization_id = ${params.organizationId}
          AND y.resolved_at IS NULL
          AND y.created_at > ${params.since.toISOString()}::timestamptz
          AND y.created_at <= ${params.until.toISOString()}::timestamptz
          AND y.kind = 'agent'
      )
      SELECT caller_id,
        COUNT(*)::int AS yells,
        COUNT(DISTINCT session_id)::int AS sessions,
        MIN(created_at) AS first_at,
        MAX(created_at) AS last_at,
        COALESCE(to_jsonb((ARRAY_AGG(id::text ORDER BY created_at DESC, id DESC)
          FILTER (WHERE rn <= ${params.evidenceLimit}::int))[1:${params.evidenceLimit}::int]), '[]'::jsonb) AS recent_ids
      FROM ranked
      GROUP BY caller_id
      ORDER BY yells DESC, caller_id
      LIMIT ${params.limit}
    `);
    return UnresolvedAgentYellsByCallerRowSchema.array().parse(result.rows);
  }
}

const UnresolvedAgentYellsByCallerRowSchema = z
  .object({
    caller_id: z.string(),
    yells: z.number().int(),
    sessions: z.number().int(),
    first_at: z.coerce.date(),
    last_at: z.coerce.date(),
    recent_ids: z.array(z.uuid()),
  })
  .transform(({ caller_id, first_at, last_at, recent_ids, ...row }) => ({
    ...row,
    callerId: caller_id,
    firstAt: first_at,
    lastAt: last_at,
    recentIds: recent_ids,
  }));

const UnresolvedWaiversByToolRowSchema = z
  .object({
    tool: z.string(),
    yells: z.number().int(),
    calls: z.number().int(),
    sessions: z.number().int(),
    first_at: z.coerce.date(),
    last_at: z.coerce.date(),
    kinds: z.array(OpenAppaYellKindSchema.exclude(["agent"])),
    recent_ids: z.array(z.uuid()),
  })
  .transform(({ first_at, last_at, recent_ids, ...row }) => ({
    ...row,
    firstAt: first_at,
    lastAt: last_at,
    recentIds: recent_ids,
  }));

function callerCondition(scope: YellScope) {
  return scope.callerId === undefined
    ? undefined
    : eq(table.callerId, scope.callerId);
}

function metadataColumns() {
  const { archive, conversationId, ...columns } = getTableColumns(table);
  return { ...columns, hasArchive: sql<boolean>`${archive} IS NOT NULL` };
}
