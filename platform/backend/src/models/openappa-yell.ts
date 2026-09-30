import {
  and,
  count,
  desc,
  eq,
  ilike,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import db from "@/database";
import { openappaYellsTable as table } from "@/database/schemas/openappa-yell";
import {
  createCursorPaginatedResult,
  decodeCursor,
} from "@/database/utils/pagination";
import type {
  InsertOpenAppaYell,
  OpenAppaYellQuery,
} from "@/types/openappa-yell";

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
      .returning();
    if (row) return row;
    const [existing] = await db
      .select()
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

  static async find(params: {
    id: string;
    organizationId: string;
    callerId?: string;
  }) {
    const [row] = await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.id, params.id),
          eq(table.organizationId, params.organizationId),
          params.callerId ? eq(table.callerId, params.callerId) : undefined,
        ),
      );
    return row ?? null;
  }

  static async summary(params: { organizationId: string; callerId?: string }) {
    const [row] = await db
      .select({ unresolved: count() })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          isNull(table.resolvedAt),
          params.callerId ? eq(table.callerId, params.callerId) : undefined,
        ),
      );
    return { unresolved: row?.unresolved ?? 0 };
  }

  static async list(
    params: OpenAppaYellQuery & { organizationId: string; callerId?: string },
  ) {
    const position = decodeCursor(params.cursor);
    const validCursor =
      position &&
      z.uuid().safeParse(position.id).success &&
      !Number.isNaN(Date.parse(position.value));
    const rows = await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          params.callerId ? eq(table.callerId, params.callerId) : undefined,
          params.status === "unresolved"
            ? isNull(table.resolvedAt)
            : params.status === "resolved"
              ? isNotNull(table.resolvedAt)
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

  static async setResolved(params: {
    id: string;
    organizationId: string;
    userId: string;
    resolved: boolean;
    callerId?: string;
  }) {
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
          params.callerId ? eq(table.callerId, params.callerId) : undefined,
        ),
      )
      .returning();
    return row ?? null;
  }
}
