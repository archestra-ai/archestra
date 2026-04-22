import { createHash } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import type { MemoryScopeType } from "@/types/memory-item";
import type { MemoryTombstoneReason } from "@/types/memory-tombstone";

class MemoryTombstoneModel {
  static async record(
    params: {
      organizationId: string;
      scopeType: MemoryScopeType;
      scopeId: string;
      content: string;
      reason: MemoryTombstoneReason;
      ttlDays?: number;
    },
    txOrDb: Transaction | typeof db = db,
  ): Promise<void> {
    const ttlDays = params.ttlDays ?? 30;
    const contentHash = hashMemoryContent(params.content);
    const expiresAt = new Date(Date.now() + ttlDays * MS_IN_DAY);

    await txOrDb
      .insert(schema.memoryTombstonesTable)
      .values({
        organizationId: params.organizationId,
        scopeType: params.scopeType,
        scopeId: params.scopeId,
        contentHash,
        reason: params.reason,
        expiresAt,
      })
      .onConflictDoNothing({
        target: [
          schema.memoryTombstonesTable.organizationId,
          schema.memoryTombstonesTable.scopeType,
          schema.memoryTombstonesTable.scopeId,
          schema.memoryTombstonesTable.contentHash,
        ],
      });
  }

  static async exists(params: {
    organizationId: string;
    scopeType: MemoryScopeType;
    scopeId: string;
    contentHash: string;
  }): Promise<boolean> {
    const [result] = await db
      .select({ id: schema.memoryTombstonesTable.id })
      .from(schema.memoryTombstonesTable)
      .where(
        and(
          eq(
            schema.memoryTombstonesTable.organizationId,
            params.organizationId,
          ),
          eq(schema.memoryTombstonesTable.scopeType, params.scopeType),
          eq(schema.memoryTombstonesTable.scopeId, params.scopeId),
          eq(schema.memoryTombstonesTable.contentHash, params.contentHash),
          gt(schema.memoryTombstonesTable.expiresAt, new Date()),
        ),
      )
      .limit(1);

    return result !== undefined;
  }

  static async pruneExpired(): Promise<number> {
    const deleted = await db
      .delete(schema.memoryTombstonesTable)
      .where(lt(schema.memoryTombstonesTable.expiresAt, new Date()))
      .returning({ id: schema.memoryTombstonesTable.id });

    return deleted.length;
  }

  static getContentHash(content: string): string {
    return hashMemoryContent(content);
  }
}

export default MemoryTombstoneModel;

const MS_IN_DAY = 24 * 60 * 60 * 1000;

function hashMemoryContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
