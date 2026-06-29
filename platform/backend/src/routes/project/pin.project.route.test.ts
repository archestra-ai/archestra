import { ProjectPinModel, ProjectShareModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("PUT/DELETE /api/projects/:id/pin", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let owner: User;
  let actingUser: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    organizationId = (await makeOrganization()).id;
    owner = await makeUser();
    actingUser = owner;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
      (request as typeof request & { user: User }).user = actingUser;
    });
    const { default: projectRoutes } = await import("./project.routes");
    await app.register(projectRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function seedProject(name = "pinnable") {
    return projectService.create({
      organizationId,
      userId: owner.id,
      name,
      description: null,
    });
  }

  test("owner can pin and unpin; pinnedAt surfaces in list()", async () => {
    const project = await seedProject();

    const pin = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/pin`,
    });
    expect(pin.statusCode).toBe(200);
    let list = await projectService.list({ organizationId, userId: owner.id });
    expect(list.find((p) => p.id === project.id)?.pinnedAt).toBeInstanceOf(
      Date,
    );

    const unpin = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/pin`,
    });
    expect(unpin.statusCode).toBe(200);
    list = await projectService.list({ organizationId, userId: owner.id });
    expect(list.find((p) => p.id === project.id)?.pinnedAt).toBeNull();
  });

  test("pins are per-user on a shared project", async ({
    makeUser,
    makeMember,
  }) => {
    const project = await seedProject("shared");
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
    });
    const member = await makeUser({ email: "pin-member@test.com" });
    await makeMember(member.id, organizationId, {});

    actingUser = member;
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/projects/${project.id}/pin`,
        })
      ).statusCode,
    ).toBe(200);

    const memberList = await projectService.list({
      organizationId,
      userId: member.id,
    });
    const ownerList = await projectService.list({
      organizationId,
      userId: owner.id,
    });
    expect(
      memberList.find((p) => p.id === project.id)?.pinnedAt,
    ).toBeInstanceOf(Date);
    expect(ownerList.find((p) => p.id === project.id)?.pinnedAt).toBeNull();
  });

  test("pinning a project you cannot read returns 404", async ({
    makeUser,
    makeMember,
  }) => {
    const project = await seedProject("private"); // owner-only, not shared
    const stranger = await makeUser({ email: "pin-stranger@test.com" });
    await makeMember(stranger.id, organizationId, {});
    actingUser = stranger;

    const res = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/pin`,
    });
    expect(res.statusCode).toBe(404);
  });

  test("can unpin after the project is unshared (no 404, pin removed)", async ({
    makeUser,
    makeMember,
  }) => {
    const project = await seedProject("transient");
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
    });
    const member = await makeUser({ email: "pin-unshare@test.com" });
    await makeMember(member.id, organizationId, {});

    actingUser = member;
    await app.inject({ method: "PUT", url: `/api/projects/${project.id}/pin` });

    // owner unshares
    await ProjectShareModel.remove(project.id);

    // member can still unpin even though the project now 404s for reads
    actingUser = member;
    const unpin = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/pin`,
    });
    expect(unpin.statusCode).toBe(200);
    const pins = await ProjectPinModel.getPinnedAtForProjects({
      userId: member.id,
      projectIds: [project.id],
    });
    expect(pins.has(project.id)).toBe(false);
  });
});
