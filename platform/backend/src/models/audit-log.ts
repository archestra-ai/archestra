import type { PaginationQuery } from "@shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import db, { schema } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type { AuditLog, InsertAuditLog, SortingQuery } from "@/types";
import { escapeLikePattern } from "@/utils/sql-search";

class AuditLogModel {
  async create(data: InsertAuditLog): Promise<AuditLog> {
    const [auditLog] = await db
      .insert(schema.auditLogsTable)
      .values(data)
      .returning();

    return auditLog as AuditLog;
  }

  async findAllPaginated(
    organizationId: string,
    pagination: PaginationQuery,
    sorting?: SortingQuery,
    userId?: string,
    isAdmin?: boolean,
    filters?: {
      action?: string;
      resource?: string;
      userId?: string;
      startDate?: string;
      endDate?: string;
      search?: string;
    },
  ): Promise<PaginatedResult<AuditLog>> {
    const orderByClause = this.getOrderByClause(sorting);

    const conditions: SQL[] = [
      eq(schema.auditLogsTable.organizationId, organizationId),
    ];

    if (userId && !isAdmin) {
      conditions.push(eq(schema.auditLogsTable.userId, userId));
    }

    if (filters?.action) {
      conditions.push(eq(schema.auditLogsTable.action, filters.action));
    }

    if (filters?.resource) {
      conditions.push(eq(schema.auditLogsTable.resource, filters.resource));
    }

    if (filters?.userId) {
      conditions.push(eq(schema.auditLogsTable.userId, filters.userId));
    }

    if (filters?.startDate) {
      conditions.push(
        gte(schema.auditLogsTable.createdAt, new Date(filters.startDate)),
      );
    }

    if (filters?.endDate) {
      conditions.push(
        lte(schema.auditLogsTable.createdAt, new Date(filters.endDate)),
      );
    }

    if (filters?.search) {
      const searchPattern = `%${escapeLikePattern(filters.search)}%`;
      conditions.push(
        or(
          ilike(schema.auditLogsTable.action, searchPattern),
          ilike(schema.auditLogsTable.resource, searchPattern),
          ilike(schema.auditLogsTable.resourceId, searchPattern),
        )!,
      );
    }

    const whereClause = and(...conditions);

    const [data, [{ total }]] = await Promise.all([
      db
        .select({
          ...getTableColumns(schema.auditLogsTable),
          userName: schema.usersTable.name,
          userEmail: schema.usersTable.email,
        })
        .from(schema.auditLogsTable)
        .leftJoin(
          schema.usersTable,
          eq(schema.auditLogsTable.userId, schema.usersTable.id),
        )
        .where(whereClause)
        .orderBy(orderByClause)
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({ total: count() })
        .from(schema.auditLogsTable)
        .where(whereClause),
    ]);

    return createPaginatedResult(data as AuditLog[], Number(total), pagination);
  }

  async findById(
    id: string,
    organizationId: string,
    userId?: string,
    isAdmin?: boolean,
  ): Promise<AuditLog | null> {
    const conditions: SQL[] = [
      eq(schema.auditLogsTable.id, id),
      eq(schema.auditLogsTable.organizationId, organizationId),
    ];

    if (userId && !isAdmin) {
      conditions.push(eq(schema.auditLogsTable.userId, userId));
    }

    const [auditLog] = await db
      .select({
        ...getTableColumns(schema.auditLogsTable),
        userName: schema.usersTable.name,
        userEmail: schema.usersTable.email,
      })
      .from(schema.auditLogsTable)
      .leftJoin(
        schema.usersTable,
        eq(schema.auditLogsTable.userId, schema.usersTable.id),
      )
      .where(and(...conditions));

    return (auditLog as AuditLog) ?? null;
  }

  private getOrderByClause(sorting?: SortingQuery) {
    const direction = sorting?.sortDirection === "asc" ? asc : desc;

    switch (sorting?.sortBy) {
      case "action":
        return direction(schema.auditLogsTable.action);
      case "resource":
        return direction(schema.auditLogsTable.resource);
      case "createdAt":
      default:
        return desc(schema.auditLogsTable.createdAt);
    }
  }
}

const auditLogModel = new AuditLogModel();
export default auditLogModel;
