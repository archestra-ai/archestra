import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  gte,
  ilike,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import db, { schema } from "@/database";
import type { AuditEvent, InsertAuditEvent } from "@/types";

export default class AuditEventModel {
  static async create(event: InsertAuditEvent): Promise<AuditEvent> {
    const [created] = await db
      .insert(schema.auditEventsTable)
      .values(event)
      .returning();

    // Best-effort realtime fanout (durability is the DB row).
    await AuditEventModel.notifyCreated(created);
    return created;
  }

  static async getById(params: {
    organizationId: string;
    id: string;
  }): Promise<AuditEvent | null> {
    const [row] = await db
      .select()
      .from(schema.auditEventsTable)
      .where(
        and(
          eq(schema.auditEventsTable.organizationId, params.organizationId),
          eq(schema.auditEventsTable.id, params.id),
        ),
      )
      .limit(1);

    return row ?? null;
  }

  static async getAllPaginated(params: {
    organizationId: string;
    limit: number;
    offset: number;
    actorUserId?: string;
    action?: string;
    resourceType?: string;
    from?: Date;
    to?: Date;
    search?: string;
  }): Promise<{ data: AuditEvent[]; total: number }> {
    const {
      organizationId,
      limit,
      offset,
      actorUserId,
      action,
      resourceType,
      from,
      to,
      search,
    } = params;

    const conditions = [
      eq(schema.auditEventsTable.organizationId, organizationId),
      actorUserId
        ? eq(schema.auditEventsTable.actorUserId, actorUserId)
        : undefined,
      action ? eq(schema.auditEventsTable.action, action) : undefined,
      resourceType
        ? eq(schema.auditEventsTable.resourceType, resourceType)
        : undefined,
      from ? gte(schema.auditEventsTable.createdAt, from) : undefined,
      to ? lte(schema.auditEventsTable.createdAt, to) : undefined,
      search
        ? orSearchCondition({
            search,
          })
        : undefined,
    ].filter(Boolean);

    const where = and(
      ...(conditions as NonNullable<(typeof conditions)[number]>[]),
    );

    const [data, totalResult] = await Promise.all([
      db
        .select()
        .from(schema.auditEventsTable)
        .where(where)
        .orderBy(desc(schema.auditEventsTable.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(schema.auditEventsTable).where(where),
    ]);

    return { data, total: totalResult[0]?.count ?? 0 };
  }

  static async getCreatedAfter(params: {
    organizationId: string;
    after: Date;
    limit: number;
  }): Promise<AuditEvent[]> {
    return await db
      .select()
      .from(schema.auditEventsTable)
      .where(
        and(
          eq(schema.auditEventsTable.organizationId, params.organizationId),
          gt(schema.auditEventsTable.createdAt, params.after),
        ),
      )
      .orderBy(asc(schema.auditEventsTable.createdAt))
      .limit(params.limit);
  }

  static async deleteOlderThan(params: { olderThan: Date }): Promise<number> {
    const result = await db
      .delete(schema.auditEventsTable)
      .where(lt(schema.auditEventsTable.createdAt, params.olderThan))
      .returning({ id: schema.auditEventsTable.id });
    return result.length;
  }

  private static async notifyCreated(event: AuditEvent): Promise<void> {
    try {
      await db.execute(
        sql`SELECT pg_notify('audit_events_created', ${JSON.stringify({
          ...event,
          createdAt: event.createdAt.toISOString(),
        })})`,
      );
    } catch {
      // Ignore notification failures; listeners can fall back to polling.
    }
  }
}

function orSearchCondition(params: { search: string }) {
  const search = `%${params.search}%`;

  return or(
    ilike(schema.auditEventsTable.action, search),
    ilike(schema.auditEventsTable.resourceType, search),
    ilike(schema.auditEventsTable.resourceId, search),
    ilike(schema.auditEventsTable.ipAddress, search),
    ilike(schema.auditEventsTable.userAgent, search),
  );
}
