import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import MemoryItemModel from "./memory-item";

describe("MemoryItemModel candidate TTL", () => {
  test("archives only stale candidate items", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();

    const staleCandidate = await MemoryItemModel.create({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: user.id,
      kind: "preference",
      status: "candidate",
      content: "stale candidate",
      createdBy: user.id,
      policyFlags: [],
    });

    const freshCandidate = await MemoryItemModel.create({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: user.id,
      kind: "preference",
      status: "candidate",
      content: "fresh candidate",
      createdBy: user.id,
      policyFlags: [],
    });

    const approved = await MemoryItemModel.create({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: user.id,
      kind: "preference",
      status: "approved",
      content: "approved memory",
      createdBy: user.id,
      policyFlags: [],
    });

    await db
      .update(schema.memoryItemsTable)
      .set({
        createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      })
      .where(
        and(
          eq(schema.memoryItemsTable.id, staleCandidate.id),
          eq(schema.memoryItemsTable.organizationId, organization.id),
        ),
      );

    const archivedCount = await MemoryItemModel.archiveStaleCandidates({
      ttlDays: 30,
    });
    expect(archivedCount).toBe(1);

    const staleAfter = await MemoryItemModel.getById({
      id: staleCandidate.id,
      organizationId: organization.id,
    });
    const freshAfter = await MemoryItemModel.getById({
      id: freshCandidate.id,
      organizationId: organization.id,
    });
    const approvedAfter = await MemoryItemModel.getById({
      id: approved.id,
      organizationId: organization.id,
    });

    expect(staleAfter?.status).toBe("archived");
    expect(freshAfter?.status).toBe("candidate");
    expect(approvedAfter?.status).toBe("approved");
  });
});
