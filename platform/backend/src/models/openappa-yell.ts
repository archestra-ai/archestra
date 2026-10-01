import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
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
import { normalizeByteaField } from "@/utils/normalize-bytea";

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

  static async findArchive(params: { id: string; organizationId: string }) {
    const [row] = await db
      .select({ archive: table.archive })
      .from(table)
      .where(
        and(
          eq(table.id, params.id),
          eq(table.organizationId, params.organizationId),
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

  static async find(params: { id: string; organizationId: string }) {
    const [row] = await db
      .select(metadataColumns())
      .from(table)
      .where(
        and(
          eq(table.id, params.id),
          eq(table.organizationId, params.organizationId),
        ),
      );
    return row ?? null;
  }

  static async summary(params: { organizationId: string }) {
    const [row] = await db
      .select({ unresolved: count() })
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          isNull(table.resolvedAt),
        ),
      );
    return { unresolved: row?.unresolved ?? 0 };
  }

  static async list(params: OpenAppaYellQuery & { organizationId: string }) {
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
        ),
      )
      .returning(metadataColumns());
    return row ?? null;
  }
}

function metadataColumns() {
  const { archive, ...columns } = getTableColumns(table);
  return { ...columns, hasArchive: sql<boolean>`${archive} IS NOT NULL` };
}
