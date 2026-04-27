import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import type {
  MemoryPolicyFlag,
  MemoryScopeType,
  MemorySourceMetadata,
  MemorySourceType,
} from "@/types/memory-item";
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

  test("supports visibility matrix and count/search filters", async ({
    makeMember,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const memberUser = await makeUser();
    const secondUser = await makeUser();
    const adminUser = await makeUser();
    const team = await makeTeam(organization.id, adminUser.id);

    await makeMember(memberUser.id, organization.id, { role: "member" });
    await makeMember(secondUser.id, organization.id, { role: "member" });
    await makeMember(adminUser.id, organization.id, { role: "admin" });
    await makeTeamMember(team.id, memberUser.id, { role: "team-admin" });

    await createMemoryItem({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: memberUser.id,
      content: "Alpha preference for concise answers",
      createdBy: memberUser.id,
    });
    await createMemoryItem({
      organizationId: organization.id,
      scopeType: "team",
      scopeId: team.id,
      content: "Team convention: daily summary",
      createdBy: memberUser.id,
    });
    await createMemoryItem({
      organizationId: organization.id,
      scopeType: "organization",
      scopeId: organization.id,
      content: "Org-wide memory",
      createdBy: adminUser.id,
    });
    await createMemoryItem({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: secondUser.id,
      content: "Other user private memory",
      createdBy: secondUser.id,
    });

    const memberOnly = await MemoryItemModel.listForUser({
      userId: memberUser.id,
      organizationId: organization.id,
      teamIds: [],
      isOrgAdmin: false,
      limit: 20,
      offset: 0,
    });
    expect(memberOnly).toHaveLength(1);
    expect(memberOnly[0]?.scopeType).toBe("user");

    const teamVisible = await MemoryItemModel.listForUser({
      userId: memberUser.id,
      organizationId: organization.id,
      teamIds: [team.id],
      isOrgAdmin: false,
      limit: 20,
      offset: 0,
    });
    expect(teamVisible.map((item) => item.scopeType).sort()).toEqual([
      "team",
      "user",
    ]);

    const adminVisible = await MemoryItemModel.listForUser({
      userId: adminUser.id,
      organizationId: organization.id,
      teamIds: [team.id],
      isOrgAdmin: true,
      limit: 20,
      offset: 0,
    });
    expect(adminVisible.map((item) => item.scopeType).sort()).toEqual([
      "organization",
      "team",
    ]);

    // admin without explicit team membership must still see all team-scope items
    const adminVisibleNoTeams = await MemoryItemModel.listForUser({
      userId: adminUser.id,
      organizationId: organization.id,
      teamIds: [],
      isOrgAdmin: true,
      limit: 20,
      offset: 0,
    });
    expect(adminVisibleNoTeams.map((item) => item.scopeType).sort()).toEqual([
      "organization",
      "team",
    ]);

    const searchCount = await MemoryItemModel.countForUser({
      userId: memberUser.id,
      organizationId: organization.id,
      teamIds: [team.id],
      isOrgAdmin: false,
      search: "daily",
    });
    expect(searchCount).toBe(1);
  });

  test("handles pending review role matrix", async ({
    makeMember,
    makeOrganization,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const teamAdminUser = await makeUser();
    const orgAdminUser = await makeUser();
    const team = await makeTeam(organization.id, orgAdminUser.id);

    await makeMember(user.id, organization.id, { role: "member" });
    await makeMember(teamAdminUser.id, organization.id, { role: "member" });
    await makeMember(orgAdminUser.id, organization.id, { role: "admin" });
    await makeTeamMember(team.id, teamAdminUser.id, { role: "team_admin" });

    await createMemoryItem({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: teamAdminUser.id,
      status: "candidate",
      content: "User candidate",
      createdBy: teamAdminUser.id,
    });
    await createMemoryItem({
      organizationId: organization.id,
      scopeType: "team",
      scopeId: team.id,
      status: "candidate",
      content: "Team candidate",
      createdBy: teamAdminUser.id,
    });
    await createMemoryItem({
      organizationId: organization.id,
      scopeType: "organization",
      scopeId: organization.id,
      status: "candidate",
      content: "Organization candidate",
      createdBy: orgAdminUser.id,
    });

    const memberCount = await MemoryItemModel.countPendingReview({
      organizationId: organization.id,
      requesterUserId: teamAdminUser.id,
      requesterRole: "member",
      teamIds: [team.id],
    });
    expect(memberCount).toBe(1);

    const teamAdminCount = await MemoryItemModel.countPendingReview({
      organizationId: organization.id,
      requesterUserId: teamAdminUser.id,
      requesterRole: "team admin",
      teamIds: [team.id],
    });
    expect(teamAdminCount).toBe(2);

    const orgAdminCount = await MemoryItemModel.countPendingReview({
      organizationId: organization.id,
      requesterUserId: orgAdminUser.id,
      requesterRole: "admin",
      teamIds: [team.id],
    });
    expect(orgAdminCount).toBe(2);

    // admin without team membership must still see all team-scope pending items
    const orgAdminCountNoTeams = await MemoryItemModel.countPendingReview({
      organizationId: organization.id,
      requesterUserId: orgAdminUser.id,
      requesterRole: "admin",
      teamIds: [],
    });
    expect(orgAdminCountNoTeams).toBe(2);
  });

  test("supports includeOrganizationScope in retrieval and excludes source-deleted", async ({
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(organization.id, user.id);

    await createMemoryItem({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: user.id,
      status: "approved",
      content: "User scoped retrieval memory",
      createdBy: user.id,
    });
    await createMemoryItem({
      organizationId: organization.id,
      scopeType: "team",
      scopeId: team.id,
      status: "approved",
      content: "Team scoped retrieval memory",
      createdBy: user.id,
    });
    await createMemoryItem({
      organizationId: organization.id,
      scopeType: "organization",
      scopeId: organization.id,
      status: "approved",
      content: "Organization scoped retrieval memory",
      createdBy: user.id,
    });
    await createMemoryItem({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: user.id,
      status: "approved",
      content: "Excluded source-deleted memory",
      policyFlags: ["source_deleted"],
      createdBy: user.id,
    });

    const withoutOrgScope = await MemoryItemModel.listApprovedForRetrieval({
      userId: user.id,
      organizationId: organization.id,
      teamIds: [team.id],
      includeOrganizationScope: false,
      limit: 20,
    });
    expect(
      withoutOrgScope.some((item) => item.scopeType === "organization"),
    ).toBe(false);
    expect(
      withoutOrgScope.some((item) => item.content.includes("source-deleted")),
    ).toBe(false);

    const withOrgScope = await MemoryItemModel.listApprovedForRetrieval({
      userId: user.id,
      organizationId: organization.id,
      teamIds: [team.id],
      includeOrganizationScope: true,
      limit: 20,
    });
    expect(withOrgScope.some((item) => item.scopeType === "organization")).toBe(
      true,
    );
  });

  test("supports archive/unarchive contract and rejects invalid transitions", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();

    const candidate = await createMemoryItem({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: user.id,
      status: "candidate",
      content: "Transition candidate",
      createdBy: user.id,
    });

    const rejectedWithoutReason = await MemoryItemModel.transitionStatus({
      id: candidate.id,
      organizationId: organization.id,
      newStatus: "rejected",
      reviewerId: user.id,
    });
    expect(rejectedWithoutReason).toBeNull();

    const archivedCandidate = await MemoryItemModel.transitionStatus({
      id: candidate.id,
      organizationId: organization.id,
      newStatus: "archived",
      reviewerId: user.id,
    });
    expect(archivedCandidate?.status).toBe("archived");

    const restoredCandidate = await MemoryItemModel.transitionStatus({
      id: candidate.id,
      organizationId: organization.id,
      newStatus: "candidate",
      reviewerId: user.id,
    });
    expect(restoredCandidate?.status).toBe("candidate");

    const approved = await MemoryItemModel.transitionStatus({
      id: candidate.id,
      organizationId: organization.id,
      newStatus: "approved",
      reviewerId: user.id,
    });
    expect(approved?.status).toBe("approved");

    const archivedApproved = await MemoryItemModel.transitionStatus({
      id: candidate.id,
      organizationId: organization.id,
      newStatus: "archived",
      reviewerId: user.id,
    });
    expect(archivedApproved?.status).toBe("archived");

    const invalidTransition = await MemoryItemModel.transitionStatus({
      id: candidate.id,
      organizationId: organization.id,
      newStatus: "rejected",
      reviewerId: user.id,
      rejectionReason: "inaccurate",
    });
    expect(invalidTransition).toBeNull();

    const invalidRestoreToApproved = await MemoryItemModel.transitionStatus({
      id: candidate.id,
      organizationId: organization.id,
      newStatus: "approved",
      reviewerId: user.id,
    });
    expect(invalidRestoreToApproved).toBeNull();
  });

  test("supports sourceType/sourceId filters and idempotency lookup", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();

    await createMemoryItem({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: user.id,
      status: "candidate",
      content: "Chat sourced memory",
      createdBy: user.id,
      sourceType: "chat",
      sourceId: "conversation-1",
      sourceMetadata: {
        origin: { channel: "chat", conversationId: "conversation-1" },
        ingestion: { runId: "run-1", idempotencyKey: "idem-1" },
        actor: { kind: "agent", agentId: "agent-1" },
        quality: { extractorVersion: "v1.0.0" },
        safety: { policyFlags: [] },
        future: { projectId: null, workspaceId: null, sectionId: null },
      },
    });

    await createMemoryItem({
      organizationId: organization.id,
      scopeType: "user",
      scopeId: user.id,
      status: "candidate",
      content: "Manual sourced memory",
      createdBy: user.id,
      sourceType: "manual",
      sourceId: "manual:user",
      sourceMetadata: {
        origin: { channel: "manual" },
        ingestion: { runId: "run-2" },
        actor: { kind: "user", userId: user.id },
        quality: {},
        safety: { policyFlags: [] },
        future: { projectId: null, workspaceId: null, sectionId: null },
      },
    });

    const filtered = await MemoryItemModel.listForUser({
      userId: user.id,
      organizationId: organization.id,
      teamIds: [],
      isOrgAdmin: false,
      sourceType: "chat",
      sourceId: "conversation-1",
      limit: 10,
      offset: 0,
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.content).toContain("Chat sourced memory");

    const exists = await MemoryItemModel.existsByIngestionIdempotencyKey({
      organizationId: organization.id,
      sourceType: "chat",
      idempotencyKey: "idem-1",
    });
    expect(exists).toBe(true);
  });

  test("team-admin without team membership cannot see other team items", async ({
    makeOrganization,
    makeTeam,
    makeUser,
    makeMember,
  }) => {
    const organization = await makeOrganization();
    const teamAdmin = await makeUser();
    const otherTeamOwner = await makeUser();
    const otherTeam = await makeTeam(organization.id, otherTeamOwner.id);

    await makeMember(teamAdmin.id, organization.id, { role: "member" });
    await makeMember(otherTeamOwner.id, organization.id, { role: "member" });

    await createMemoryItem({
      organizationId: organization.id,
      scopeType: "team",
      scopeId: otherTeam.id,
      status: "candidate",
      content: "Secret team convention",
      createdBy: otherTeamOwner.id,
    });

    const count = await MemoryItemModel.countPendingReview({
      organizationId: organization.id,
      requesterUserId: teamAdmin.id,
      requesterRole: "team admin",
      teamIds: [],
    });
    expect(count).toBe(0);

    const list = await MemoryItemModel.listForUser({
      userId: teamAdmin.id,
      organizationId: organization.id,
      teamIds: [],
      isOrgAdmin: false,
      limit: 20,
      offset: 0,
    });
    expect(list.filter((item) => item.scopeType === "team")).toHaveLength(0);
  });
});

type CreateMemoryItemParams = {
  organizationId: string;
  scopeType: MemoryScopeType;
  scopeId: string;
  status?: "candidate" | "approved";
  content: string;
  policyFlags?: MemoryPolicyFlag[];
  createdBy?: string | null;
  sourceType?: MemorySourceType;
  sourceId?: string | null;
  sourceMetadata?: MemorySourceMetadata | null;
};

async function createMemoryItem(params: CreateMemoryItemParams) {
  return await MemoryItemModel.create({
    organizationId: params.organizationId,
    scopeType: params.scopeType,
    scopeId: params.scopeId,
    kind: "preference",
    status: params.status ?? "approved",
    content: params.content,
    createdBy: params.createdBy ?? null,
    policyFlags: params.policyFlags ?? [],
    sourceType: params.sourceType,
    sourceId: params.sourceId ?? null,
    sourceMetadata: params.sourceMetadata ?? null,
  });
}
