import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { ProjectShareModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

/** Names of the projects returned by GET /api/projects, in response order. */
function names(json: string): string[] {
  return (JSON.parse(json) as Array<{ name: string }>).map((p) => p.name);
}

describe("GET /api/projects (scope + search)", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let viewer: User;
  let actingUser: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    organizationId = (await makeOrganization()).id;
    viewer = await makeUser();
    actingUser = viewer;

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

  test("scope filters personal vs shared; default returns both", async ({
    makeUser,
    makeMember,
  }) => {
    await makeMember(viewer.id, organizationId, {});
    await projectService.create({
      organizationId,
      userId: viewer.id,
      name: "mine",
      description: null,
    });

    const otherOwner = await makeUser({ email: "scope-other@test.com" });
    const shared = await projectService.create({
      organizationId,
      userId: otherOwner.id,
      name: "shared-org",
      description: null,
    });
    await ProjectShareModel.upsert({
      projectId: shared.id,
      organizationId,
      createdByUserId: otherOwner.id,
      visibility: "organization",
      teamIds: [],
    });

    const all = await app.inject({ method: "GET", url: "/api/projects" });
    expect(names(all.body).sort()).toEqual(["mine", "shared-org"]);

    const personal = await app.inject({
      method: "GET",
      url: "/api/projects?scope=personal",
    });
    expect(names(personal.body)).toEqual(["mine"]);
    expect(personal.json<Array<{ viewerRole: string }>>()[0]?.viewerRole).toBe(
      "owner",
    );

    const sharedOnly = await app.inject({
      method: "GET",
      url: "/api/projects?scope=shared",
    });
    expect(names(sharedOnly.body)).toEqual(["shared-org"]);
    expect(
      sharedOnly.json<Array<{ viewerRole: string }>>()[0]?.viewerRole,
    ).toBe("shared");
  });

  test("search matches name and description, case-insensitively", async () => {
    await projectService.create({
      organizationId,
      userId: viewer.id,
      name: "alpha",
      description: "about cats",
    });
    await projectService.create({
      organizationId,
      userId: viewer.id,
      name: "beta",
      description: "about dogs",
    });

    const byName = await app.inject({
      method: "GET",
      url: "/api/projects?search=ALPHA",
    });
    expect(names(byName.body)).toEqual(["alpha"]);

    const byDescription = await app.inject({
      method: "GET",
      url: "/api/projects?search=cats",
    });
    expect(names(byDescription.body)).toEqual(["alpha"]);

    const byShared = await app.inject({
      method: "GET",
      url: "/api/projects?search=about",
    });
    expect(names(byShared.body).sort()).toEqual(["alpha", "beta"]);
  });

  test("admin scope=others excludes projects already shared to the admin", async ({
    makeUser,
    makeMember,
  }) => {
    const otherOwner = await makeUser({ email: "others-owner@test.com" });
    const unshared = await projectService.create({
      organizationId,
      userId: otherOwner.id,
      name: "oversight-only",
      description: null,
    });
    const sharedToAll = await projectService.create({
      organizationId,
      userId: otherOwner.id,
      name: "shared-to-admin",
      description: null,
    });
    await ProjectShareModel.upsert({
      projectId: sharedToAll.id,
      organizationId,
      createdByUserId: otherOwner.id,
      visibility: "organization",
      teamIds: [],
    });

    const admin = await makeUser({ email: "list-admin@test.com" });
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    actingUser = admin;

    // "others" is oversight-only: the org-shared project is reachable via share,
    // so it stays under "shared" and must NOT double-appear under "others".
    const others = await app.inject({
      method: "GET",
      url: "/api/projects?scope=others",
    });
    expect(names(others.body)).toEqual(["oversight-only"]);
    expect(others.json<Array<{ id: string }>>()[0]?.id).toBe(unshared.id);

    const sharedScope = await app.inject({
      method: "GET",
      url: "/api/projects?scope=shared",
    });
    expect(names(sharedScope.body)).toEqual(["shared-to-admin"]);
  });
});
