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
  AuditAction,
  AuditLog,
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
    actorUserId?: string;
    action?: AuditAction;
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
      actorUserId,
      action,
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
    if (actorUserId) {
      conditions.push(eq(schema.auditLogsTable.actorUserId, actorUserId));
    }
    if (action) {
      conditions.push(eq(schema.auditLogsTable.action, action));
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
    const orderBy =
      sortDirection === "asc"
        ? asc(schema.auditLogsTable.createdAt)
        : desc(schema.auditLogsTable.createdAt);

    const [data, [{ total }]] = await Promise.all([
      db
        .select()
        .from(schema.auditLogsTable)
        .where(whereClause)
        .orderBy(orderBy)
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
}

export default AuditLogModel;
