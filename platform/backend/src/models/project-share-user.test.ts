import { ProjectModel, ProjectShareModel } from "@/models";
import { describe, expect, test } from "@/test";

async function seedProject(params: { organizationId: string; userId: string }) {
  const project = await ProjectModel.create({
    organizationId: params.organizationId,
    userId: params.userId,
    name: `project-${Math.random().toString(36).slice(2, 8)}`,
  });
  if (!project) throw new Error("failed to seed project");
  return project;
}

describe("project sharing with named users", () => {
  test("a project shared by name reaches exactly the people named", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const invited = await makeUser();
    const bystander = await makeUser();
    const project = await seedProject({
      organizationId: org.id,
      userId: owner.id,
    });

    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId: org.id,
      createdByUserId: owner.id,
      visibility: "user",
      teamIds: [],
      userIds: [invited.id],
    });

    const canAccess = (userId: string) =>
      ProjectShareModel.userCanAccessProject({
        project,
        userId,
        organizationId: org.id,
      });

    expect(await canAccess(invited.id)).toBe(true);
    // Not named, and a user share is not an org share.
    expect(await canAccess(bystander.id)).toBe(false);
    // The owner always keeps their own project.
    expect(await canAccess(owner.id)).toBe(true);
  });

  test("a user-shared project appears in the grantee's list", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const invited = await makeUser();
    const project = await seedProject({
      organizationId: org.id,
      userId: owner.id,
    });

    const listFor = (userId: string) =>
      ProjectShareModel.listAccessibleProjects({
        userId,
        organizationId: org.id,
      });

    expect((await listFor(invited.id)).map((p) => p.id)).not.toContain(
      project.id,
    );

    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId: org.id,
      createdByUserId: owner.id,
      visibility: "user",
      teamIds: [],
      userIds: [invited.id],
    });

    expect((await listFor(invited.id)).map((p) => p.id)).toContain(project.id);
  });

  test("switching visibility away from user revokes the grants it left", async ({
    makeUser,
    makeOrganization,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const invited = await makeUser();
    const team = await makeTeam(org.id, owner.id, { name: "Platform" });
    const project = await seedProject({
      organizationId: org.id,
      userId: owner.id,
    });

    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId: org.id,
      createdByUserId: owner.id,
      visibility: "user",
      teamIds: [],
      userIds: [invited.id],
    });
    // Re-share to a team the grantee is not on: the old grant must not linger.
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId: org.id,
      createdByUserId: owner.id,
      visibility: "team",
      teamIds: [team.id],
      userIds: [],
    });

    expect(
      await ProjectShareModel.userCanAccessProject({
        project,
        userId: invited.id,
        organizationId: org.id,
      }),
    ).toBe(false);
  });
});
