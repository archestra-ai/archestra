import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { ProjectShareModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { fileStore } from "@/skills-sandbox/file-store";
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
    const items = list.json<Array<{ name: string; viewerRole: string }>>();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "alpha", viewerRole: "shared" });

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

  test("a project admin sees, reads, edits, and deletes other members' projects (oversight)", async ({
    makeUser,
    makeMember,
  }) => {
    const otherOwner = await makeUser({ email: "proj-other-owner@test.com" });
    await makeMember(otherOwner.id, organizationId, {});
    const project = await projectService.create({
      organizationId,
      userId: otherOwner.id,
      name: "owned-by-other",
      description: null,
    });

    const admin = await makeUser({ email: "proj-admin@test.com" });
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    actingUser = admin;

    // The other member's PRIVATE project surfaces for the admin under
    // scope=personal, tagged as oversight ("admin") with the owner's name.
    const personal = await app.inject({
      method: "GET",
      url: "/api/projects?scope=personal",
    });
    const items =
      personal.json<
        Array<{ name: string; viewerRole: string; ownerName: string | null }>
      >();
    const overseen = items.find((p) => p.name === "owned-by-other");
    expect(overseen).toMatchObject({ viewerRole: "admin" });
    expect(overseen?.ownerName).toBe(otherOwner.name);

    // Detail is readable, tagged admin, and exposes shareTeamIds for the edit dialog.
    const detail = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(
      detail.json<{ viewerRole: string; shareTeamIds: string[] | null }>(),
    ).toMatchObject({ viewerRole: "admin", shareTeamIds: [] });

    // Admin can edit and delete the project.
    const edit = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { description: "annotated by admin" },
    });
    expect(edit.statusCode).toBe(200);
    const del = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
    });
    expect(del.statusCode).toBe(200);
  });

  test("a project admin can manage a project shared with them (not only owned/overseen)", async ({
    makeUser,
    makeMember,
  }) => {
    const otherOwner = await makeUser({ email: "proj-share-owner@test.com" });
    await makeMember(otherOwner.id, organizationId, {});
    const project = await projectService.create({
      organizationId,
      userId: otherOwner.id,
      name: "shared-org-wide",
      description: null,
    });
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId,
      createdByUserId: otherOwner.id,
      visibility: "organization",
      teamIds: [],
    });

    const admin = await makeUser({ email: "proj-admin-share@test.com" });
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    actingUser = admin;

    // The admin reaches it via the org share, so viewerRole is "shared" (not
    // oversight) — but a project:admin may still manage it, so the detail exposes
    // shareTeamIds (for the edit dialog) instead of null...
    const detail = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(
      detail.json<{ viewerRole: string; shareTeamIds: string[] | null }>(),
    ).toMatchObject({ viewerRole: "shared", shareTeamIds: [] });

    // ...and the edit goes through (requireManageable allows project:admin).
    const edit = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { description: "edited by admin via share" },
    });
    expect(edit.statusCode).toBe(200);
  });

  test("a non-admin member cannot see or manage other members' projects", async ({
    makeUser,
    makeMember,
  }) => {
    const otherOwner = await makeUser({ email: "proj-other-owner2@test.com" });
    await makeMember(otherOwner.id, organizationId, {});
    const project = await projectService.create({
      organizationId,
      userId: otherOwner.id,
      name: "private-other",
      description: null,
    });

    const member = await makeUser({ email: "proj-plain-member@test.com" });
    await makeMember(member.id, organizationId, {});
    actingUser = member;

    // A non-admin never sees another member's private project — not in the
    // default list, nor under scope=personal.
    expect(
      (await app.inject({ method: "GET", url: "/api/projects" })).json<
        unknown[]
      >(),
    ).toEqual([]);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/projects?scope=personal",
        })
      ).json<unknown[]>(),
    ).toEqual([]);

    // ...and they cannot edit or delete it (404, same as "not found").
    const edit = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { description: "nope" },
    });
    expect(edit.statusCode).toBe(404);
    const del = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}`,
    });
    expect(del.statusCode).toBe(404);
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

describe("GET /api/projects/:id/files", () => {
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

  test("members of a shared project see the project's files; outsiders 404", async ({
    makeUser,
    makeMember,
  }) => {
    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "filed",
      description: null,
    });
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
    });

    const { SkillSandboxModel } = await import("@/models");
    const sandbox = await SkillSandboxModel.create({
      organizationId,
      userId: owner.id,
      conversationId: null,
      defaultCwd: "/sandbox",
    });
    await fileStore.put({
      organizationId,
      userId: owner.id,
      projectId: project.id,
      conversationId: null,
      sandboxId: sandbox.id,
      filename: "in-project.txt",
      mimeType: "text/plain",
      sizeBytes: 2,
      data: Buffer.from("in"),
    });
    // the owner's personal file must not appear in the project listing
    await fileStore.put({
      organizationId,
      userId: owner.id,
      projectId: null,
      conversationId: null,
      sandboxId: sandbox.id,
      filename: "elsewhere.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      data: Buffer.from("out"),
    });

    const member = await makeUser({ email: "proj-files-member@test.com" });
    await makeMember(member.id, organizationId, {});
    actingUser = member;

    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/files`,
    });
    expect(response.statusCode).toBe(200);
    const files =
      response.json<
        Array<{ filename: string; projectId: string; projectName: string }>
      >();
    expect(files.map((f) => f.filename)).toEqual(["in-project.txt"]);
    expect(files[0]).toMatchObject({
      projectId: project.id,
      projectName: "filed",
    });

    await ProjectShareModel.remove(project.id);
    const denied = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/files`,
    });
    expect(denied.statusCode).toBe(404);
  });
});
