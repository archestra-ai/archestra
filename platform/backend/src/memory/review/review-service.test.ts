import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import MemoryItemModel from "@/models/memory-item";
import MemoryTombstoneModel from "@/models/memory-tombstone";
import { describe, expect, test } from "@/test";
import { memoryReviewService } from "./review-service";

describe("memoryReviewService", () => {
  test("approve/reject/archive/unarchive/delete enforce auth and transitions", async ({
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    const outsider = await makeUser();

    await makeMember(owner.id, organization.id, { role: "member" });
    await makeMember(outsider.id, organization.id, { role: "member" });

    const candidate = await MemoryItemModel.create({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: owner.id,
      kind: "preference",
      status: "candidate",
      content: "Owner candidate",
      createdBy: owner.id,
      policyFlags: [],
    });

    const blockedApproval = await memoryReviewService.approve({
      itemId: candidate.id,
      organizationId: organization.id,
      reviewer: { id: outsider.id, role: "member" },
      teamIds: [],
    });
    expect(blockedApproval).toBeNull();

    const approved = await memoryReviewService.approve({
      itemId: candidate.id,
      organizationId: organization.id,
      reviewer: { id: owner.id, role: "member" },
      teamIds: [],
    });
    expect(approved?.status).toBe("approved");

    const archived = await memoryReviewService.archive({
      itemId: candidate.id,
      organizationId: organization.id,
      reviewer: { id: owner.id, role: "member" },
      teamIds: [],
    });
    expect(archived?.status).toBe("archived");

    const restored = await memoryReviewService.unarchive({
      itemId: candidate.id,
      organizationId: organization.id,
      reviewer: { id: owner.id, role: "member" },
      teamIds: [],
    });
    expect(restored?.status).toBe("candidate");

    const rejected = await memoryReviewService.reject({
      itemId: candidate.id,
      organizationId: organization.id,
      reviewer: { id: owner.id, role: "member" },
      rejectionReason: "duplicate",
    });
    expect(rejected?.status).toBe("rejected");

    const archivedRejected = await memoryReviewService.archive({
      itemId: candidate.id,
      organizationId: organization.id,
      reviewer: { id: owner.id, role: "member" },
      teamIds: [],
    });
    expect(archivedRejected?.status).toBe("archived");

    const blockedDelete = await memoryReviewService.hardDelete({
      itemId: candidate.id,
      organizationId: organization.id,
      reviewer: { id: outsider.id, role: "member" },
      teamIds: [],
    });
    expect(blockedDelete).toBe(false);

    const deleted = await memoryReviewService.hardDelete({
      itemId: candidate.id,
      organizationId: organization.id,
      reviewer: { id: owner.id, role: "member" },
      teamIds: [],
    });
    expect(deleted).toBe(true);
  });

  test("manualCreate is candidate-only and respects scope authorization", async ({
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    const outsider = await makeUser();

    await makeMember(owner.id, organization.id, { role: "member" });
    await makeMember(outsider.id, organization.id, { role: "member" });

    const blockedCreate = await memoryReviewService.manualCreate({
      organizationId: organization.id,
      requester: { id: outsider.id, role: "member" },
      data: {
        scopeType: "user",
        scopeId: owner.id,
        kind: "instruction",
        content: "Do not create for someone else",
      },
    });
    expect(blockedCreate).toBeNull();

    const created = await memoryReviewService.manualCreate({
      organizationId: organization.id,
      requester: { id: owner.id, role: "member" },
      data: {
        scopeType: "user",
        scopeId: owner.id,
        kind: "instruction",
        content: "Owner creates own candidate",
      },
    });

    expect(created?.status).toBe("candidate");
    expect(created?.sourceType).toBe("manual");
    expect(created?.sourceId).toContain(`manual:${owner.id}:`);
    expect(created?.sourceMetadata).not.toBeNull();
  });

  test("manualCreate blocks secret-like content before persistence", async ({
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();

    await makeMember(owner.id, organization.id, { role: "member" });

    await expect(
      memoryReviewService.manualCreate({
        organizationId: organization.id,
        requester: { id: owner.id, role: "member" },
        data: {
          scopeType: "user",
          scopeId: owner.id,
          kind: "profile_fact",
          content: "api_key=sk-1234567890abcdefghijklmnopqrstuvwxyz",
        },
      }),
    ).rejects.toMatchObject({
      reason: "sensitive",
    });
  });

  test("supersede rejects empty patch and creates candidate for approved source", async ({
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();

    await makeMember(owner.id, organization.id, { role: "member" });

    const approved = await MemoryItemModel.create({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: owner.id,
      kind: "preference",
      status: "approved",
      content: "Original approved memory",
      createdBy: owner.id,
      reviewedBy: owner.id,
      reviewedAt: new Date(),
      policyFlags: [],
    });

    const emptyPatch = await memoryReviewService.proposeSupersedingEdit({
      itemId: approved.id,
      organizationId: organization.id,
      requester: { id: owner.id, role: "member" },
      patch: {},
    });
    expect(emptyPatch).toBeNull();

    const superseded = await memoryReviewService.proposeSupersedingEdit({
      itemId: approved.id,
      organizationId: organization.id,
      requester: { id: owner.id, role: "member" },
      patch: {
        content: "Updated memory content",
      },
    });
    expect(superseded?.status).toBe("candidate");
    expect(superseded?.supersedesMemoryId).toBe(approved.id);
  });

  test("supersede blocks tombstoned replacement content before candidate creation", async ({
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();

    await makeMember(owner.id, organization.id, { role: "member" });

    const approved = await MemoryItemModel.create({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: owner.id,
      kind: "preference",
      status: "approved",
      content: "Original approved memory",
      createdBy: owner.id,
      reviewedBy: owner.id,
      reviewedAt: new Date(),
      policyFlags: [],
    });

    const blockedContent = "Never persist this manipulative instruction again.";
    await MemoryTombstoneModel.record({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: owner.id,
      content: blockedContent,
      reason: "rejected",
    });

    await expect(
      memoryReviewService.proposeSupersedingEdit({
        itemId: approved.id,
        organizationId: organization.id,
        requester: { id: owner.id, role: "member" },
        patch: {
          content: blockedContent,
        },
      }),
    ).rejects.toMatchObject({
      reason: "tombstone_hit",
    });
  });

  test("approve blocks candidates with high-risk policy flags", async ({
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();

    await makeMember(owner.id, organization.id, { role: "member" });

    const candidate = await MemoryItemModel.create({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: owner.id,
      kind: "instruction",
      status: "candidate",
      content: "Potentially manipulative instruction",
      createdBy: owner.id,
      policyFlags: ["instruction_like", "instruction_like_medium"],
    });

    await expect(
      memoryReviewService.approve({
        itemId: candidate.id,
        organizationId: organization.id,
        reviewer: { id: owner.id, role: "member" },
        teamIds: [],
      }),
    ).rejects.toMatchObject({
      reason: "high_risk_policy_flags",
    });
  });

  test("rejection tombstone is created only for manipulative or sensitive", async ({
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    await makeMember(owner.id, organization.id, { role: "member" });

    const sensitiveCandidate = await MemoryItemModel.create({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: owner.id,
      kind: "preference",
      status: "candidate",
      content: "Sensitive candidate",
      createdBy: owner.id,
      policyFlags: [],
    });

    await memoryReviewService.reject({
      itemId: sensitiveCandidate.id,
      organizationId: organization.id,
      reviewer: { id: owner.id, role: "member" },
      rejectionReason: "sensitive",
    });

    const sensitiveHash = MemoryTombstoneModel.getContentHash(
      "Sensitive candidate",
    );
    const sensitiveExists = await MemoryTombstoneModel.exists({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: owner.id,
      contentHash: sensitiveHash,
    });
    expect(sensitiveExists).toBe(true);

    const duplicateCandidate = await MemoryItemModel.create({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: owner.id,
      kind: "preference",
      status: "candidate",
      content: "Duplicate candidate",
      createdBy: owner.id,
      policyFlags: [],
    });

    await memoryReviewService.reject({
      itemId: duplicateCandidate.id,
      organizationId: organization.id,
      reviewer: { id: owner.id, role: "member" },
      rejectionReason: "duplicate",
    });

    const duplicateHash = MemoryTombstoneModel.getContentHash(
      "Duplicate candidate",
    );
    const duplicateExists = await MemoryTombstoneModel.exists({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: owner.id,
      contentHash: duplicateHash,
    });
    expect(duplicateExists).toBe(false);

    const manipulativeCandidate = await MemoryItemModel.create({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: owner.id,
      kind: "instruction",
      status: "candidate",
      content: "Manipulative candidate",
      createdBy: owner.id,
      policyFlags: [],
    });

    await memoryReviewService.reject({
      itemId: manipulativeCandidate.id,
      organizationId: organization.id,
      reviewer: { id: owner.id, role: "member" },
      rejectionReason: "manipulative",
    });

    const manipulativeRow = await db
      .select()
      .from(schema.memoryTombstonesTable)
      .where(
        and(
          eq(schema.memoryTombstonesTable.organizationId, organization.id),
          eq(schema.memoryTombstonesTable.scopeType, "user"),
          eq(schema.memoryTombstonesTable.scopeId, owner.id),
          eq(
            schema.memoryTombstonesTable.contentHash,
            MemoryTombstoneModel.getContentHash("Manipulative candidate"),
          ),
        ),
      )
      .limit(1);

    expect(manipulativeRow[0]?.expiresAt).toBeNull();
  });
});
