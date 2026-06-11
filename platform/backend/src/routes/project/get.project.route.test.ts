import { ProjectShareModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GET /api/projects + GET /api/projects/:id", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;
  /** Lets each test choose who the request runs as. */
  let actingUser: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    actingUser = user;

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

  test("list returns own and shared projects; detail hides share teams from non-owners", async ({
    makeUser,
    makeMember,
  }) => {
    const project = await projectService.create({
      organizationId,
      userId: user.id,
      name: "alpha",
      description: null,
    });
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId,
      createdByUserId: user.id,
      visibility: "organization",
      teamIds: [],
    });

    const viewer = await makeUser({ email: "proj-viewer@test.com" });
    await makeMember(viewer.id, organizationId, {});
    actingUser = viewer;

    const list = await app.inject({ method: "GET", url: "/api/projects" });
    expect(list.statusCode).toBe(200);
    const items = list.json<Array<{ name: string; isOwner: boolean }>>();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "alpha", isOwner: false });

    const detail = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ shareTeamIds: null }>().shareTeamIds).toBeNull();

    actingUser = user;
    const ownDetail = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
    });
    expect(ownDetail.json<{ shareTeamIds: string[] }>().shareTeamIds).toEqual(
      [],
    );
  });

  test("an unshared project 404s for everyone but the owner", async ({
    makeUser,
    makeMember,
  }) => {
    const project = await projectService.create({
      organizationId,
      userId: user.id,
      name: "private",
      description: null,
    });
    const outsider = await makeUser({ email: "proj-outsider@test.com" });
    await makeMember(outsider.id, organizationId, {});
    actingUser = outsider;

    const detail = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
    });
    expect(detail.statusCode).toBe(404);
    const list = await app.inject({ method: "GET", url: "/api/projects" });
    expect(list.json<unknown[]>()).toEqual([]);
  });
});
