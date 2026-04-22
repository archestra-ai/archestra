import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import MemoryItemModel from "./memory-item";
import MemoryTombstoneModel from "./memory-tombstone";

describe("MemoryItemModel", () => {
  test("supports create/list/transition/delete round-trip", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();

    const created = await MemoryItemModel.create({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: user.id,
      kind: "preference",
      status: "candidate",
      content: "Prefer concise responses",
      createdBy: user.id,
      policyFlags: [],
    });

    const visibleToUser = await MemoryItemModel.listForUser({
      userId: user.id,
      organizationId: organization.id,
      teamIds: [],
      isOrgAdmin: false,
      limit: 10,
      offset: 0,
    });
    expect(visibleToUser.map((item) => item.id)).toContain(created.id);

    const approved = await MemoryItemModel.transitionStatus({
      id: created.id,
      organizationId: organization.id,
      newStatus: "approved",
      reviewerId: user.id,
    });
    expect(approved?.status).toBe("approved");

    const retrieval = await MemoryItemModel.listApprovedForRetrieval({
      userId: user.id,
      organizationId: organization.id,
      teamIds: [],
      limit: 10,
    });
    expect(retrieval.map((item) => item.id)).toContain(created.id);

    const deleted = await MemoryItemModel.hardDelete({
      id: created.id,
      organizationId: organization.id,
    });
    expect(deleted).toBe(true);

    const afterDelete = await MemoryItemModel.getById({
      id: created.id,
      organizationId: organization.id,
    });
    expect(afterDelete).toBeNull();

    const [tombstone] = await db
      .select()
      .from(schema.memoryTombstonesTable)
      .where(
        and(
          eq(schema.memoryTombstonesTable.organizationId, organization.id),
          eq(schema.memoryTombstonesTable.scopeType, "user"),
          eq(schema.memoryTombstonesTable.scopeId, user.id),
        ),
      )
      .limit(1);

    expect(tombstone).toBeDefined();
    expect(tombstone?.contentHash).toBeTruthy();
    if (!tombstone) {
      throw new Error("Expected tombstone to exist after hardDelete");
    }

    const tombstoneExists = await MemoryTombstoneModel.exists({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: user.id,
      contentHash: tombstone.contentHash,
    });
    expect(tombstoneExists).toBe(true);
  });
});
