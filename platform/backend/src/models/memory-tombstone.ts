import { createHash } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import { normalizeMemoryContent } from "@/memory/policy/normalize-content";
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
      ttlDays?: number | null;
    },
    txOrDb: Transaction | typeof db = db,
  ): Promise<void> {
    const ttlDays = params.ttlDays ?? 30;
    const contentHash = hashNormalizedMemoryContent(params.content);
    const expiresAt =
      params.ttlDays === null
        ? null
        : new Date(Date.now() + ttlDays * MS_IN_DAY);

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
          or(
            isNull(schema.memoryTombstonesTable.expiresAt),
            gt(schema.memoryTombstonesTable.expiresAt, new Date()),
          ),
        ),
      )
      .limit(1);

    return result !== undefined;
  }

  static async findActiveMatchByContent(params: {
    organizationId: string;
    scopeType: MemoryScopeType;
    scopeId: string;
    content: string;
  }): Promise<{
    matched: boolean;
    reason: MemoryTombstoneReason | null;
    matchType: "normalized" | "legacy_exact" | null;
  }> {
    const normalizedHash = hashNormalizedMemoryContent(params.content);
    const legacyHash = hashLegacyMemoryContent(params.content);
    const hashes = Array.from(new Set([normalizedHash, legacyHash]));

    const [result] = await db
      .select({
        contentHash: schema.memoryTombstonesTable.contentHash,
        reason: schema.memoryTombstonesTable.reason,
      })
      .from(schema.memoryTombstonesTable)
      .where(
        and(
          eq(
            schema.memoryTombstonesTable.organizationId,
            params.organizationId,
          ),
          eq(schema.memoryTombstonesTable.scopeType, params.scopeType),
          eq(schema.memoryTombstonesTable.scopeId, params.scopeId),
          inArray(schema.memoryTombstonesTable.contentHash, hashes),
          or(
            isNull(schema.memoryTombstonesTable.expiresAt),
            gt(schema.memoryTombstonesTable.expiresAt, new Date()),
          ),
        ),
      )
      .limit(1);

    if (!result) {
      return { matched: false, reason: null, matchType: null };
    }

    return {
      matched: true,
      reason: result.reason,
      matchType:
        result.contentHash === normalizedHash ? "normalized" : "legacy_exact",
    };
  }

  static async pruneExpired(): Promise<number> {
    const deleted = await db
      .delete(schema.memoryTombstonesTable)
      .where(
        and(
          isNotNull(schema.memoryTombstonesTable.expiresAt),
          lt(schema.memoryTombstonesTable.expiresAt, new Date()),
        ),
      )
      .returning({ id: schema.memoryTombstonesTable.id });

    return deleted.length;
  }

  static getContentHash(content: string): string {
    return hashNormalizedMemoryContent(content);
  }

  static getLegacyContentHash(content: string): string {
    return hashLegacyMemoryContent(content);
  }
}

export default MemoryTombstoneModel;

const MS_IN_DAY = 24 * 60 * 60 * 1000;

function hashNormalizedMemoryContent(content: string): string {
  return createHash("sha256")
    .update(normalizeMemoryContent(content))
    .digest("hex");
}

function hashLegacyMemoryContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
