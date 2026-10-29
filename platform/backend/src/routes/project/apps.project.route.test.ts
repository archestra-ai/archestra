import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { shareForTest } from "@/test/sharing";
import type { User } from "@/types";

describe("GET/PUT/DELETE /api/projects/:id/apps", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let owner: User;
  let actingUser: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    owner = await makeUser();
    await makeMember(owner.id, organizationId, {});
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

  const seedProject = (name = "with-apps") =>
    projectService.create({
      organizationId,
      userId: owner.id,
      name,
      description: null,
    });

  const listApps = async (projectId: string) => {
    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/apps`,
    });
    expect(response.statusCode).toBe(200);
    return (response.json() as Array<{ id: string }>).map((a) => a.id);
  };

  test("links, lists, and unlinks an app", async ({ makeApp }) => {
    const project = await seedProject();
    const tracker = await makeApp({ organizationId, authorId: owner.id });

    const link = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/apps/${tracker.id}`,
    });
    expect(link.statusCode).toBe(200);
    // Idempotent: a second link is not an error and not a duplicate.
    await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/apps/${tracker.id}`,
    });
    expect(await listApps(project.id)).toEqual([tracker.id]);

    const unlink = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/apps/${tracker.id}`,
    });
    expect(unlink.statusCode).toBe(200);
    expect(await listApps(project.id)).toEqual([]);

    const again = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/apps/${tracker.id}`,
    });
    expect(again.statusCode).toBe(404);
  });

  test("refuses to link an app the caller cannot read", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const project = await seedProject();
    const stranger = await makeUser();
    await makeMember(stranger.id, organizationId, {});
    const theirs = await makeApp({
      organizationId,
      authorId: stranger.id,
      access: "personal",
    });

    const response = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/apps/${theirs.id}`,
    });

    expect(response.statusCode).toBe(404);
    expect(await listApps(project.id)).toEqual([]);
  });

  test("a project member sees only the linked apps they can read", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const project = await seedProject("shared-apps");
    await shareForTest({
      resource: "project",
      scope: project.id,
      organizationId,
      visibility: "organization",
      teamIds: [],
    });
    const orgApp = await makeApp({ organizationId, authorId: owner.id });
    const ownerOnlyApp = await makeApp({
      organizationId,
      authorId: owner.id,
      access: "personal",
    });
    for (const linked of [orgApp, ownerOnlyApp]) {
      await projectService.linkApp({
        id: project.id,
        appId: linked.id,
        organizationId,
        userId: owner.id,
      });
    }
    const member = await makeUser();
    await makeMember(member.id, organizationId, {});

    actingUser = member;
    expect(await listApps(project.id)).toEqual([orgApp.id]);

    actingUser = owner;
    expect((await listApps(project.id)).sort()).toEqual(
      [orgApp.id, ownerOnlyApp.id].sort(),
    );
  });

  test("a non-member cannot list or link", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const project = await seedProject("private-apps");
    const outsider = await makeUser();
    await makeMember(outsider.id, organizationId, {});
    const orgApp = await makeApp({ organizationId, authorId: owner.id });

    actingUser = outsider;
    const list = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/apps`,
    });
    const link = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/apps/${orgApp.id}`,
    });

    expect(list.statusCode).toBe(404);
    expect(link.statusCode).toBe(404);
  });
});
