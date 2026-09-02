import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  lt,
  lte,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import db, { schema } from "@/database";
import {
  type CursorPaginatedResult,
  createCursorPaginatedResult,
  createPaginatedResult,
  decodeCursor,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type {
  AuditActorType,
  AuditEventName,
  AuditLog,
  AuditLogWithImpersonator,
  AuditOutcome,
  InsertAuditLog,
  SortDirection,
} from "@/types";

function escapeLikePattern(value: string): string {
  return value.replace(/[%_\\]/g, "\\$&");
}

function buildSearchCondition(search: string) {
  const trimmed = search.trim();
  if (!trimmed) return undefined;
  const pattern = `%${escapeLikePattern(trimmed)}%`;
  return or(
    ilike(schema.auditLogsTable.actorEmail, pattern),
    ilike(schema.auditLogsTable.actorName, pattern),
    ilike(schema.auditLogsTable.httpPath, pattern),
    ilike(schema.auditLogsTable.resourceId, pattern),
    ilike(schema.auditLogsTable.resourceName, pattern),
  );
}

/** Self-join alias: resolve the impersonator's email for display. */
const impersonatorUsers = alias(schema.usersTable, "impersonator_users");

class AuditLogModel {
  static async create(input: InsertAuditLog): Promise<AuditLog> {
    const [row] = await db
      .insert(schema.auditLogsTable)
      .values(input)
      .returning();
    return row;
  }

  static async findById(
    id: string,
    organizationId: string,
  ): Promise<AuditLogWithImpersonator | null> {
    const [row] = await db
      .select({
        ...getTableColumns(schema.auditLogsTable),
        impersonatedByEmail: impersonatorUsers.email,
      })
      .from(schema.auditLogsTable)
      .leftJoin(
        impersonatorUsers,
        eq(schema.auditLogsTable.impersonatedBy, impersonatorUsers.id),
      )
      .where(
        and(
          eq(schema.auditLogsTable.id, id),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      )
      .limit(1);

    return (row as AuditLogWithImpersonator | undefined) ?? null;
  }

  static async findPaginated(opts: {
    organizationId: string;
    limit: number;
    offset: number;
    sortDirection?: SortDirection;
    startDate?: Date;
    endDate?: Date;
    actorId?: string;
    action?: AuditEventName;
    outcome?: AuditOutcome;
    actorType?: AuditActorType;
    resourceType?: string;
    resourceId?: string;
    search?: string;
  }): Promise<PaginatedResult<AuditLogWithImpersonator>> {
    const { limit, offset, sortDirection = "desc" } = opts;

    const whereClause = and(...AuditLogModel.buildFilterConditions(opts));
    const orderBy = AuditLogModel.buildOrderBy(sortDirection);

    const [data, [{ total }]] = await Promise.all([
      db
        .select({
          ...getTableColumns(schema.auditLogsTable),
          // Human-readable attribution for rows written during impersonation
          // (impersonatedBy alone is an opaque user id). Null when the row is
          // not impersonation-attributed or the impersonator was deleted.
          impersonatedByEmail: impersonatorUsers.email,
        })
        .from(schema.auditLogsTable)
        .leftJoin(
          impersonatorUsers,
          eq(schema.auditLogsTable.impersonatedBy, impersonatorUsers.id),
        )
        .where(whereClause)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(schema.auditLogsTable)
        .where(whereClause),
    ]);

    return createPaginatedResult(
      data as AuditLogWithImpersonator[],
      Number(total),
      {
        limit,
        offset,
      },
    );
  }

  /**
   * The same listing, walked by cursor instead of offset.
   *
   * Two costs disappear. There is no `count()`, so a page no longer scans
   * every row in the organization to render a page number nobody navigates
   * by. And there is no offset, so page one thousand costs what page one
   * costs — the keyset predicate seeks straight to the position and reads
   * `limit + 1` rows, where an offset would have read and thrown away
   * everything above it.
   *
   * `(created_at, event_sequence)` is the key. `event_sequence` is a
   * postgres-assigned bigserial, so the pair is strictly ordered and unique
   * even when many rows share a timestamp, and the existing index covers it.
   */
  static async findCursorPaginated(opts: {
    organizationId: string;
    limit: number;
    cursor?: string;
    sortDirection?: SortDirection;
    startDate?: Date;
    endDate?: Date;
    actorId?: string;
    action?: AuditEventName;
    outcome?: AuditOutcome;
    actorType?: AuditActorType;
    resourceType?: string;
    resourceId?: string;
    search?: string;
  }): Promise<CursorPaginatedResult<AuditLogWithImpersonator>> {
    const { limit, cursor, sortDirection = "desc" } = opts;

    const conditions = AuditLogModel.buildFilterConditions(opts);

    // An unreadable cursor is treated as no cursor, so a stale or truncated
    // link lands on the newest page instead of erroring.
    const position = decodeCursor(cursor);
    if (position) {
      const at = new Date(position.value);
      const seq = Number(position.id);
      if (!Number.isNaN(at.getTime()) && Number.isFinite(seq)) {
        // Row comparison, not two ANDed predicates: `(a, b) < (x, y)` is one
        // ordered comparison the planner can drive the composite index from.
        const keyset = sql`(${schema.auditLogsTable.createdAt}, ${schema.auditLogsTable.eventSequence})`;
        conditions.push(
          sortDirection === "asc"
            ? sql`${keyset} > (${at}, ${seq})`
            : sql`${keyset} < (${at}, ${seq})`,
        );
      }
    }

    const rows = await db
      .select({
        ...getTableColumns(schema.auditLogsTable),
        impersonatedByEmail: impersonatorUsers.email,
      })
      .from(schema.auditLogsTable)
      .leftJoin(
        impersonatorUsers,
        eq(schema.auditLogsTable.impersonatedBy, impersonatorUsers.id),
      )
      .where(and(...conditions))
      .orderBy(...AuditLogModel.buildOrderBy(sortDirection))
      // One more than the page needs: its presence is what answers "is there
      // another page", replacing the count this method no longer runs.
      .limit(limit + 1);

    return createCursorPaginatedResult(
      rows as AuditLogWithImpersonator[],
      { limit, cursor },
      (row) => ({
        value: row.createdAt.toISOString(),
        id: String(row.eventSequence),
      }),
    );
  }

  static async deleteOlderThan(opts: {
    organizationId: string;
    before: Date;
  }): Promise<number> {
    // `.returning({ id })` rather than `result.rowCount` so this works on
    // both the pg driver (production) and the PGlite driver used in tests,
    // which doesn't populate `rowCount` for bare DELETEs.
    const deleted = await db
      .delete(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.organizationId, opts.organizationId),
          lt(schema.auditLogsTable.createdAt, opts.before),
        ),
      )
      .returning({ id: schema.auditLogsTable.id });
    return deleted.length;
  }

  /**
   * Delete every audit row created strictly before `before`, across all
   * organizations. Used by the retention sweep so it can run as a single
   * query instead of N round-trips per org.
   */
  static async deleteAllOlderThan(before: Date): Promise<number> {
    const deleted = await db
      .delete(schema.auditLogsTable)
      .where(lt(schema.auditLogsTable.createdAt, before))
      .returning({ id: schema.auditLogsTable.id });
    return deleted.length;
  }

  /**
   * The filter predicates both listing methods share, so the offset and
   * cursor paths cannot drift into disagreeing about what a filter means.
   */
  private static buildFilterConditions(opts: {
    organizationId: string;
    startDate?: Date;
    endDate?: Date;
    actorId?: string;
    action?: AuditEventName;
    outcome?: AuditOutcome;
    actorType?: AuditActorType;
    resourceType?: string;
    resourceId?: string;
    search?: string;
  }): SQL[] {
    const conditions: SQL[] = [
      eq(schema.auditLogsTable.organizationId, opts.organizationId),
    ];

    if (opts.startDate) {
      conditions.push(gte(schema.auditLogsTable.createdAt, opts.startDate));
    }
    if (opts.endDate) {
      conditions.push(lte(schema.auditLogsTable.createdAt, opts.endDate));
    }
    if (opts.actorId) {
      conditions.push(eq(schema.auditLogsTable.actorId, opts.actorId));
    }
    if (opts.action) {
      conditions.push(eq(schema.auditLogsTable.action, opts.action));
    }
    if (opts.outcome) {
      conditions.push(eq(schema.auditLogsTable.outcome, opts.outcome));
    }
    if (opts.actorType) {
      conditions.push(eq(schema.auditLogsTable.actorType, opts.actorType));
    }
    if (opts.resourceType) {
      conditions.push(
        eq(schema.auditLogsTable.resourceType, opts.resourceType),
      );
    }
    if (opts.resourceId) {
      conditions.push(eq(schema.auditLogsTable.resourceId, opts.resourceId));
    }
    if (opts.search) {
      const searchCondition = buildSearchCondition(opts.search);
      if (searchCondition) {
        conditions.push(searchCondition);
      }
    }

    return conditions;
  }

  /**
   * Two-column sort: created_at tiebroken by event_sequence (a
   * postgres-assigned bigserial, always monotonic). The matching index covers
   * both columns, and the cursor's keyset predicate compares the same pair.
   */
  private static buildOrderBy(sortDirection: SortDirection) {
    return sortDirection === "asc"
      ? [
          asc(schema.auditLogsTable.createdAt),
          asc(schema.auditLogsTable.eventSequence),
        ]
      : [
          desc(schema.auditLogsTable.createdAt),
          desc(schema.auditLogsTable.eventSequence),
        ];
  }
}

export default AuditLogModel;
