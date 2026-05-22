import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  lt,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import db, { schema } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type {
  AuditActorType,
  AuditEventName,
  AuditLog,
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
  );
}

class AuditLogModel {
  static async create(input: InsertAuditLog): Promise<AuditLog> {
    const [row] = await db
      .insert(schema.auditLogsTable)
      .values(input)
      .returning();
    return row;
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
    search?: string;
  }): Promise<PaginatedResult<AuditLog>> {
    const {
      organizationId,
      limit,
      offset,
      sortDirection = "desc",
      startDate,
      endDate,
      actorId,
      action,
      outcome,
      actorType,
      resourceType,
      search,
    } = opts;

    const conditions: SQL[] = [
      eq(schema.auditLogsTable.organizationId, organizationId),
    ];

    if (startDate) {
      conditions.push(gte(schema.auditLogsTable.createdAt, startDate));
    }
    if (endDate) {
      conditions.push(lte(schema.auditLogsTable.createdAt, endDate));
    }
    if (actorId) {
      conditions.push(eq(schema.auditLogsTable.actorId, actorId));
    }
    if (action) {
      conditions.push(eq(schema.auditLogsTable.action, action));
    }
    if (outcome) {
      conditions.push(eq(schema.auditLogsTable.outcome, outcome));
    }
    if (actorType) {
      conditions.push(eq(schema.auditLogsTable.actorType, actorType));
    }
    if (resourceType) {
      conditions.push(eq(schema.auditLogsTable.resourceType, resourceType));
    }
    if (search) {
      const searchCondition = buildSearchCondition(search);
      if (searchCondition) {
        conditions.push(searchCondition);
      }
    }

    const whereClause = and(...conditions);

    // Two-column sort: created_at tiebroken by event_sequence (postgres-assigned
    // bigserial, always monotonic). The matching index covers both columns.
    const orderBy =
      sortDirection === "asc"
        ? [
            asc(schema.auditLogsTable.createdAt),
            asc(schema.auditLogsTable.eventSequence),
          ]
        : [
            desc(schema.auditLogsTable.createdAt),
            desc(schema.auditLogsTable.eventSequence),
          ];

    const [data, [{ total }]] = await Promise.all([
      db
        .select()
        .from(schema.auditLogsTable)
        .where(whereClause)
        .orderBy(...orderBy)
        .limit(limit)
        .offset(offset),
      db
        .select({ total: count() })
        .from(schema.auditLogsTable)
        .where(whereClause),
    ]);

    return createPaginatedResult(data as AuditLog[], Number(total), {
      limit,
      offset,
    });
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
}

export default AuditLogModel;
