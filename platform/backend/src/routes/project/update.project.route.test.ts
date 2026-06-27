import {
  PROJECT_DESCRIPTION_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
} from "@archestra/shared";
import { ProjectModel, ProjectShareModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("PATCH/PUT share/DELETE /api/projects/:id", () => {
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

  async function seedProject(name = "mutable") {
    return projectService.create({
      organizationId,
      userId: owner.id,
      name,
      description: null,
    });
  }

  test("owner can update description, share, unshare, and delete", async ({
    makeTeam,
  }) => {
    const project = await seedProject();
    const team = await makeTeam(organizationId, owner.id, { name: "T" });

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { name: "renamed", description: "updated", icon: "🚀" },
    });
    expect(patch.statusCode).toBe(200);
    const afterPatch = await ProjectModel.findById(project.id);
    expect(afterPatch?.description).toBe("updated");
    expect(afterPatch?.name).toBe("renamed");
    expect(afterPatch?.icon).toBe("🚀");

    const share = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/share`,
      payload: { visibility: "team", teamIds: [team.id] },
    });
    expect(share.statusCode).toBe(200);
    expect(
      (await ProjectShareModel.findByProjectId(project.id))?.teamIds,
    ).toEqual([team.id]);

    const unshare = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/share`,
      payload: { visibility: "none", teamIds: [] },
    });
    expect(unshare.statusCode).toBe(200);
    expect(await ProjectShareModel.findByProjectId(project.id)).toBeNull();

    const del = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
    });
    expect(del.statusCode).toBe(200);
    expect(await ProjectModel.findById(project.id)).toBeNull();
  });

  test("rejects a description update over the max length with 400", async () => {
    const project = await seedProject("desc-limit");

    const atLimit = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { description: "x".repeat(PROJECT_DESCRIPTION_MAX_LENGTH) },
    });
    expect(atLimit.statusCode).toBe(200);

    const overLimit = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { description: "x".repeat(PROJECT_DESCRIPTION_MAX_LENGTH + 1) },
    });
    expect(overLimit.statusCode).toBe(400);
  });

  test("accepts a name update at the max length but rejects one over it", async () => {
    const project = await seedProject("name-limit");

    const atLimit = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { name: "x".repeat(PROJECT_NAME_MAX_LENGTH) },
    });
    expect(atLimit.statusCode).toBe(200);

    const overLimit = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { name: "x".repeat(PROJECT_NAME_MAX_LENGTH + 1) },
    });
    expect(overLimit.statusCode).toBe(400);
  });

  test("renaming to an existing project name returns 409", async () => {
    await seedProject("taken");
    const project = await seedProject("free");
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { name: "taken" },
    });
    expect(res.statusCode).toBe(409);
    expect((await ProjectModel.findById(project.id))?.name).toBe("free");
  });

  test("non-owners get 404 on every mutation, even with project read access", async ({
    makeUser,
    makeMember,
  }) => {
    const project = await seedProject("guarded");
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
    });
    const member = await makeUser({ email: "proj-member@test.com" });
    await makeMember(member.id, organizationId, {});
    actingUser = member;

    for (const req of [
      {
        method: "PATCH" as const,
        url: `/api/projects/${project.id}`,
        payload: { description: "nope" },
      },
      {
        method: "PUT" as const,
        url: `/api/projects/${project.id}/share`,
        payload: { visibility: "none", teamIds: [] },
      },
      {
        method: "DELETE" as const,
        url: `/api/projects/${project.id}`,
        payload: undefined,
      },
    ]) {
      const response = await app.inject(req);
      expect(response.statusCode).toBe(404);
    }
    expect(await ProjectModel.findById(project.id)).not.toBeNull();
  });
});
