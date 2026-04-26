import type { PaginationQuery } from "@shared";
import { and, count, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import db, { schema } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";

export type AuditLogResourceType =
  | "agent"
  | "member"
  | "team"
  | "organization"
  | "api_key"
  | "llm_provider"
  | "mcp_server"
  | "knowledge_base"
  | "role"
  | "auth"
  | "secret"
  | "invitation"
  | "tool_policy"
  | "identity_provider";

export type AuditLogAction =
  | "created"
  | "updated"
  | "deleted"
  | "invited"
  | "removed"
  | "login"
  | "logout"
  | "enabled"
  | "disabled"
  | "assigned"
  | "unassigned"
  | "synced";

export interface CreateAuditLogParams {
  organizationId: string;
  actorId?: string | null;
  actorName?: string | null;
  actorEmail?: string | null;
  resourceType: AuditLogResourceType;
  resourceId?: string | null;
  resourceLabel?: string | null;
  action: AuditLogAction | string;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

export interface AuditLogFilters {
  organizationId: string;
  actorId?: string;
  resourceType?: AuditLogResourceType | string;
  action?: string;
  from?: Date;
  to?: Date;
}

const AuditLogModel = {
  /**
   * Write a new audit log entry. Fire-and-forget — errors are swallowed so
   * a logging failure never interrupts the main request path.
   */
  async log(params: CreateAuditLogParams): Promise<void> {
    try {
      await db.insert(schema.auditLogsTable).values({
        id: nanoid(),
        organizationId: params.organizationId,
        actorId: params.actorId ?? null,
        actorName: params.actorName ?? null,
        actorEmail: params.actorEmail ?? null,
        resourceType: params.resourceType,
        resourceId: params.resourceId ?? null,
        resourceLabel: params.resourceLabel ?? null,
        action: params.action,
        metadata: params.metadata ? JSON.stringify(params.metadata) : null,
        ipAddress: params.ipAddress ?? null,
        createdAt: new Date(),
      });
    } catch {
      // Audit log failures must never surface to users
    }
  },

  /**
   * Query audit log entries with optional filters and pagination.
   */
  async findPaginated(
    filters: AuditLogFilters,
    pagination: PaginationQuery,
  ): Promise<PaginatedResult<typeof schema.auditLogsTable.$inferSelect>> {
    const conditions: SQL[] = [
      eq(schema.auditLogsTable.organizationId, filters.organizationId),
    ];

    if (filters.actorId) {
      conditions.push(eq(schema.auditLogsTable.actorId, filters.actorId));
    }
    if (filters.resourceType) {
      conditions.push(
        eq(schema.auditLogsTable.resourceType, filters.resourceType),
      );
    }
    if (filters.action) {
      conditions.push(eq(schema.auditLogsTable.action, filters.action));
    }
    if (filters.from) {
      conditions.push(gte(schema.auditLogsTable.createdAt, filters.from));
    }
    if (filters.to) {
      conditions.push(lte(schema.auditLogsTable.createdAt, filters.to));
    }

    const where = and(...conditions);

    const [rows, totalResult] = await Promise.all([
      db
        .select()
        .from(schema.auditLogsTable)
        .where(where)
        .orderBy(desc(schema.auditLogsTable.createdAt))
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({ total: count() })
        .from(schema.auditLogsTable)
        .where(where),
    ]);

    return createPaginatedResult(rows, totalResult[0]?.total ?? 0, pagination);
  },
};

export default AuditLogModel;
