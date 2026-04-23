import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import MemoryTombstoneModel from "./memory-tombstone";

describe("MemoryTombstoneModel", () => {
  test("record is idempotent and exists respects content hash", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const content = "Do not suggest shell one-liners without explanation";

    await MemoryTombstoneModel.record({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: user.id,
      content,
      reason: "deleted_by_user",
    });
    await MemoryTombstoneModel.record({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: user.id,
      content,
      reason: "deleted_by_user",
    });

    const rows = await db
      .select()
      .from(schema.memoryTombstonesTable)
      .where(
        and(
          eq(schema.memoryTombstonesTable.organizationId, organization.id),
          eq(schema.memoryTombstonesTable.scopeType, "user"),
          eq(schema.memoryTombstonesTable.scopeId, user.id),
        ),
      );
    expect(rows).toHaveLength(1);

    const hash = MemoryTombstoneModel.getContentHash(content);
    const exists = await MemoryTombstoneModel.exists({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: user.id,
      contentHash: hash,
    });
    expect(exists).toBe(true);

    const existsWithDifferentHash = await MemoryTombstoneModel.exists({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: user.id,
      contentHash: MemoryTombstoneModel.getContentHash("different"),
    });
    expect(existsWithDifferentHash).toBe(false);
  });

  test("pruneExpired removes only expired tombstones", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();

    await MemoryTombstoneModel.record({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: user.id,
      content: "expired tombstone",
      reason: "deleted_by_user",
      ttlDays: -1,
    });
    await MemoryTombstoneModel.record({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: user.id,
      content: "active tombstone",
      reason: "deleted_by_user",
      ttlDays: 7,
    });

    const pruned = await MemoryTombstoneModel.pruneExpired();
    expect(pruned).toBe(1);

    const remaining = await db
      .select()
      .from(schema.memoryTombstonesTable)
      .where(
        and(
          eq(schema.memoryTombstonesTable.organizationId, organization.id),
          eq(schema.memoryTombstonesTable.scopeType, "user"),
          eq(schema.memoryTombstonesTable.scopeId, user.id),
        ),
      );

    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.contentHash).toBe(
      MemoryTombstoneModel.getContentHash("active tombstone"),
    );
  });
});
