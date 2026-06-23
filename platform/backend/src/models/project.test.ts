import {
  ProjectModel,
  ProjectNameExistsError,
  ProjectShareModel,
} from "@/models";
import { describe, expect, test } from "@/test";

async function makeProject(params: {
  organizationId: string;
  userId: string;
  name: string;
}) {
  return ProjectModel.create(params);
}

describe("ProjectModel", () => {
  test("create/find/update/delete round-trip", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const project = await makeProject({
      organizationId: org.id,
      userId: user.id,
      name: "research",
    });
    expect(project.name).toBe("research");

    expect(
      (
        await ProjectModel.findByIdForOwner({
          id: project.id,
          userId: user.id,
          organizationId: org.id,
        })
      )?.id,
    ).toBe(project.id);

    const stranger = await makeUser({ email: "proj-stranger@test.com" });
    expect(
      await ProjectModel.findByIdForOwner({
        id: project.id,
        userId: stranger.id,
        organizationId: org.id,
      }),
    ).toBeNull();

    await ProjectModel.update({
      id: project.id,
      fields: { description: "all the things", icon: "🔬", name: "research-2" },
    });
    const updated = await ProjectModel.findById(project.id);
    expect(updated?.description).toBe("all the things");
    expect(updated?.icon).toBe("🔬");
    expect(updated?.name).toBe("research-2");

    await ProjectModel.delete(project.id);
    expect(await ProjectModel.findById(project.id)).toBeNull();
  });

  test("duplicate project name per user throws", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeProject({ organizationId: org.id, userId: user.id, name: "p" });
    await expect(
      ProjectModel.create({
        organizationId: org.id,
        userId: user.id,
        name: "p",
      }),
    ).rejects.toBeInstanceOf(ProjectNameExistsError);
  });

  test("generates a url-safe slug, deduped within an org", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const other = await makeUser({ email: "slug-other@test.com" });
    const first = await makeProject({
      organizationId: org.id,
      userId: owner.id,
      name: "Quarterly Report",
    });
    expect(first.slug).toBe("quarterly-report");
    // a different member may reuse the display name (names are unique per user),
    // but the slug — the shared folder — must stay distinct within the org.
    const second = await makeProject({
      organizationId: org.id,
      userId: other.id,
      name: "Quarterly Report",
    });
    expect(second.slug).not.toBe(first.slug);
    expect(second.slug.startsWith("quarterly-report-")).toBe(true);
  });

  test("deleting a project nulls its conversations", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const project = await makeProject({
      organizationId: org.id,
      userId: user.id,
      name: "doomed",
    });
    const conv = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: org.id,
    });
    // attach the conversation to the project directly (creation plumbing is
    // covered by route tests)
    const { default: db, schema } = await import("@/database");
    const { eq } = await import("drizzle-orm");
    await db
      .update(schema.conversationsTable)
      .set({ projectId: project.id })
      .where(eq(schema.conversationsTable.id, conv.id));

    await ProjectModel.delete(project.id);

    const [after] = await db
      .select()
      .from(schema.conversationsTable)
      .where(eq(schema.conversationsTable.id, conv.id));
    expect(after.projectId).toBeNull();
  });

  test("countConversations and listConversations", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeConversation,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const project = await makeProject({
      organizationId: org.id,
      userId: user.id,
      name: "counted",
    });
    const { default: db, schema } = await import("@/database");
    const { eq } = await import("drizzle-orm");
    for (const title of ["one", "two"]) {
      const conv = await makeConversation(agent.id, {
        userId: user.id,
        organizationId: org.id,
        title,
      });
      await db
        .update(schema.conversationsTable)
        .set({ projectId: project.id })
        .where(eq(schema.conversationsTable.id, conv.id));
    }

    const counts = await ProjectModel.countConversations([project.id]);
    expect(counts.get(project.id)).toBe(2);

    const listed = await ProjectModel.listConversations(project.id);
    expect(listed).toHaveLength(2);
    expect(listed[0].authorUserId).toBe(user.id);
  });
});

describe("ProjectShareModel", () => {
  test("access matrix: owner / org share / team share / outsider / cross-org", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const otherOrg = await makeOrganization();
    const owner = await makeUser();
    const teammate = await makeUser({ email: "share-teammate@test.com" });
    const orgMember = await makeUser({ email: "share-orgmember@test.com" });
    await makeMember(teammate.id, org.id, {});
    await makeMember(orgMember.id, org.id, {});
    const team = await makeTeam(org.id, owner.id, { name: "Sharers" });
    const { default: TeamModel } = await import("@/models/team");
    await TeamModel.addMember(team.id, teammate.id);

    const project = await makeProject({
      organizationId: org.id,
      userId: owner.id,
      name: "shared",
    });

    const can = (userId: string, organizationId = org.id) =>
      ProjectShareModel.userCanAccessProject({
        project,
        userId,
        organizationId,
      });

    // unshared: owner only
    expect(await can(owner.id)).toBe(true);
    expect(await can(teammate.id)).toBe(false);

    // team share
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId: org.id,
      createdByUserId: owner.id,
      visibility: "team",
      teamIds: [team.id],
    });
    expect(await can(teammate.id)).toBe(true);
    expect(await can(orgMember.id)).toBe(false);

    // org share (upsert replaces)
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId: org.id,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
    });
    expect(await can(orgMember.id)).toBe(true);
    // cross-org caller never passes
    expect(await can(orgMember.id, otherOrg.id)).toBe(false);

    // unshare
    await ProjectShareModel.remove(project.id);
    expect(await can(orgMember.id)).toBe(false);
  });

  test("listAccessibleProjects dedupes and orders own-first", async ({
    makeUser,
    makeOrganization,
    makeTeam,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const viewer = await makeUser({ email: "share-viewer@test.com" });
    await makeMember(viewer.id, org.id, {});
    const team = await makeTeam(org.id, owner.id, { name: "Viewers" });
    const { default: TeamModel } = await import("@/models/team");
    await TeamModel.addMember(team.id, viewer.id);

    const mine = await makeProject({
      organizationId: org.id,
      userId: viewer.id,
      name: "mine",
    });
    const sharedToTeam = await makeProject({
      organizationId: org.id,
      userId: owner.id,
      name: "team-shared",
    });
    await ProjectShareModel.upsert({
      projectId: sharedToTeam.id,
      organizationId: org.id,
      createdByUserId: owner.id,
      visibility: "team",
      teamIds: [team.id],
    });
    const orgShared = await makeProject({
      organizationId: org.id,
      userId: owner.id,
      name: "org-shared",
    });
    await ProjectShareModel.upsert({
      projectId: orgShared.id,
      organizationId: org.id,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
    });
    await makeProject({
      organizationId: org.id,
      userId: owner.id,
      name: "private",
    });

    const listed = await ProjectShareModel.listAccessibleProjects({
      userId: viewer.id,
      organizationId: org.id,
    });
    expect(listed.map((p) => p.name).sort()).toEqual([
      "mine",
      "org-shared",
      "team-shared",
    ]);
    expect(listed[0].id).toBe(mine.id); // own first
    expect(listed.find((p) => p.id === mine.id)?.visibility).toBeNull();
    expect(listed.find((p) => p.id === orgShared.id)?.visibility).toBe(
      "organization",
    );
  });
});
