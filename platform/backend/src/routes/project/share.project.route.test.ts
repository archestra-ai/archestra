import type { Permissions } from "@archestra/shared";
import { ProjectShareModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

/** A role like the default member's, but without `project:share-org`. */
const PROJECT_PERMISSIONS_WITHOUT_SHARE_ORG: Permissions = {
  project: ["read", "create", "update", "delete"],
};

describe("PUT /api/projects/:id/share", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
      (request as typeof request & { user: User }).user = user;
    });
    const { default: projectRoutes } = await import("./project.routes");
    await app.register(projectRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const setShare = (
    projectId: string,
    payload: { visibility: string; teamIds?: string[] },
  ) =>
    app.inject({
      method: "PUT",
      url: `/api/projects/${projectId}/share`,
      payload,
    });

  const makeOwnProject = () =>
    projectService.create({
      organizationId,
      userId: user.id,
      name: `p-${crypto.randomUUID().slice(0, 8)}`,
      description: null,
    });

  test("an owner with the default member role can share org-wide and unshare", async ({
    makeMember,
  }) => {
    await makeMember(user.id, organizationId);
    const project = await makeOwnProject();

    const shared = await setShare(project.id, { visibility: "organization" });
    expect(shared.statusCode).toBe(200);
    expect(
      (await ProjectShareModel.findByProjectId(project.id))?.visibility,
    ).toBe("organization");

    const unshared = await setShare(project.id, { visibility: "none" });
    expect(unshared.statusCode).toBe(200);
    expect(await ProjectShareModel.findByProjectId(project.id)).toBeNull();
  });

  test("an owner whose role lacks project:share-org cannot org-share", async ({
    makeCustomRole,
    makeMember,
  }) => {
    const role = await makeCustomRole(organizationId, {
      permission: PROJECT_PERMISSIONS_WITHOUT_SHARE_ORG,
    });
    await makeMember(user.id, organizationId, { role: role.role });
    const project = await makeOwnProject();

    const response = await setShare(project.id, {
      visibility: "organization",
    });
    expect(response.statusCode).toBe(403);
    expect(await ProjectShareModel.findByProjectId(project.id)).toBeNull();
  });

  test("an owner whose role lacks project:share-org can still share with teams", async ({
    makeCustomRole,
    makeMember,
    makeTeam,
    makeTeamMember,
  }) => {
    const role = await makeCustomRole(organizationId, {
      permission: PROJECT_PERMISSIONS_WITHOUT_SHARE_ORG,
    });
    await makeMember(user.id, organizationId, { role: role.role });
    const team = await makeTeam(organizationId, user.id);
    await makeTeamMember(team.id, user.id);
    const project = await makeOwnProject();

    const response = await setShare(project.id, {
      visibility: "team",
      teamIds: [team.id],
    });
    expect(response.statusCode).toBe(200);
    const share = await ProjectShareModel.findByProjectId(project.id);
    expect(share?.visibility).toBe("team");
    expect(share?.teamIds).toEqual([team.id]);
  });

  test("an owner whose role lacks project:share-org cannot change or remove an existing org-wide share", async ({
    makeCustomRole,
    makeMember,
    makeTeam,
  }) => {
    const role = await makeCustomRole(organizationId, {
      permission: PROJECT_PERMISSIONS_WITHOUT_SHARE_ORG,
    });
    await makeMember(user.id, organizationId, { role: role.role });
    const team = await makeTeam(organizationId, user.id);
    const project = await makeOwnProject();
    // Org-shared by someone holding the permission (e.g. an admin).
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId,
      createdByUserId: user.id,
      visibility: "organization",
      teamIds: [],
    });

    const downgraded = await setShare(project.id, {
      visibility: "team",
      teamIds: [team.id],
    });
    expect(downgraded.statusCode).toBe(403);

    const removed = await setShare(project.id, { visibility: "none" });
    expect(removed.statusCode).toBe(403);

    expect(
      (await ProjectShareModel.findByProjectId(project.id))?.visibility,
    ).toBe("organization");
  });

  test("an owner cannot share with a team they are not a member of", async ({
    makeMember,
    makeTeam,
  }) => {
    await makeMember(user.id, organizationId);
    // Created by the owner, but they never joined it.
    const team = await makeTeam(organizationId, user.id);
    const project = await makeOwnProject();

    const response = await setShare(project.id, {
      visibility: "team",
      teamIds: [team.id],
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toMatch(/teams you are a member of/i);
    expect(await ProjectShareModel.findByProjectId(project.id)).toBeNull();
  });

  test("a project admin can share with any team in the organization", async ({
    makeMember,
    makeTeam,
    makeUser,
  }) => {
    await makeMember(user.id, organizationId, { role: "admin" });
    const other = await makeUser();
    const team = await makeTeam(organizationId, other.id);
    const project = await makeOwnProject();

    const response = await setShare(project.id, {
      visibility: "team",
      teamIds: [team.id],
    });
    expect(response.statusCode).toBe(200);
    expect(
      (await ProjectShareModel.findByProjectId(project.id))?.teamIds,
    ).toEqual([team.id]);
  });

  test("a team from another organization is rejected", async ({
    makeMember,
    makeOrganization,
    makeTeam,
    makeUser,
  }) => {
    await makeMember(user.id, organizationId, { role: "admin" });
    const otherOrg = await makeOrganization();
    const outsider = await makeUser();
    const foreignTeam = await makeTeam(otherOrg.id, outsider.id);
    const project = await makeOwnProject();

    const response = await setShare(project.id, {
      visibility: "team",
      teamIds: [foreignTeam.id],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/unknown team id/i);
    expect(await ProjectShareModel.findByProjectId(project.id)).toBeNull();
  });

  test("a team share with no teams is rejected", async ({ makeMember }) => {
    await makeMember(user.id, organizationId);
    const project = await makeOwnProject();

    const response = await setShare(project.id, {
      visibility: "team",
      teamIds: [],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/at least one team/i);
    expect(await ProjectShareModel.findByProjectId(project.id)).toBeNull();
  });

  test("an admin can org-share another member's project", async ({
    makeMember,
    makeUser,
  }) => {
    await makeMember(user.id, organizationId, { role: "admin" });
    const owner = await makeUser();
    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "someone-elses",
      description: null,
    });

    const response = await setShare(project.id, {
      visibility: "organization",
    });
    expect(response.statusCode).toBe(200);
    expect(
      (await ProjectShareModel.findByProjectId(project.id))?.visibility,
    ).toBe("organization");
  });
});
