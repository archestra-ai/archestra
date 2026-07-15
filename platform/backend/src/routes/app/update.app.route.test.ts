import { ADMIN_ROLE_NAME } from "@archestra/shared";
import EnvironmentModel from "@/models/environment";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("PATCH /api/apps/:appId", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          organizationId: string;
          user: User;
        }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: appRoutes } = await import("./app.routes");
    await app.register(appRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("a metadata-only edit updates fields without forking a version", async ({
    makeApp,
  }) => {
    const created = await makeApp({ organizationId, scope: "org" });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { name: "Renamed", description: "new desc" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: "Renamed",
      description: "new desc",
      latestVersion: created.latestVersion,
    });
  });

  test("supplying html forks a new version", async ({ makeApp }) => {
    const created = await makeApp({ organizationId, scope: "org" });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { html: "<h1>v2</h1>" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().latestVersion).toBe(created.latestVersion + 1);
  });

  test("renaming into an existing name returns 409", async () => {
    await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Taken", html: "<p/>", scope: "org" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Other", html: "<p/>", scope: "org" },
    });
    const secondId = second.json().id as string;

    const conflict = await app.inject({
      method: "PATCH",
      url: `/api/apps/${secondId}`,
      payload: { name: "Taken" },
    });
    expect(conflict.statusCode).toBe(409);
  });

  test("rejects changing uiPermissions without supplying html (400)", async ({
    makeApp,
  }) => {
    const created = await makeApp({ organizationId, scope: "org" });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { uiPermissions: { camera: {} } },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain("requires supplying html");
  });

  test("a plain member cannot update an org-scoped app (403)", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const created = await makeApp({ organizationId, scope: "org" });
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    user = member;

    const response = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { name: "Hijacked" },
    });
    expect(response.statusCode).toBe(403);
  });

  test("returns 404 when updating an unknown app id", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/apps/${crypto.randomUUID()}`,
      payload: { name: "Ghost" },
    });
    expect(response.statusCode).toBe(404);
  });

  test("re-binds the app's environment and back to the default", async ({
    makeApp,
  }) => {
    const prod = await EnvironmentModel.create({
      organizationId,
      name: "production",
    });
    const created = await makeApp({ organizationId, scope: "org" });

    const bound = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { environmentId: prod.id },
    });
    expect(bound.statusCode).toBe(200);
    expect(bound.json().environmentId).toBe(prod.id);

    const back = await app.inject({
      method: "PATCH",
      url: `/api/apps/${created.id}`,
      payload: { environmentId: null },
    });
    expect(back.statusCode).toBe(200);
    expect(back.json().environmentId).toBeNull();
  });

  test("editing an app bound to a restricted environment does not require deploy-to-restricted when the binding is unchanged", async ({
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const restricted = await EnvironmentModel.create({
      organizationId,
      name: "restricted-prod",
      restricted: true,
    });
    // The admin (current `user`) binds the app to the restricted environment.
    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: {
        name: "Restricted App",
        scope: "org",
        environmentId: restricted.id,
      },
    });
    expect(created.statusCode).toBe(200);
    const appId = created.json().id;

    // An app admin who lacks environment:deploy-to-restricted renames the app;
    // the form echoes the unchanged environmentId. The unchanged binding must
    // not be re-authorized, so the edit succeeds rather than 403.
    const role = await makeCustomRole(organizationId, {
      permission: { app: ["admin"] },
    });
    const editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: role.role });
    user = editor;

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/apps/${appId}`,
      payload: { name: "Renamed", environmentId: restricted.id },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe("Renamed");
  });
});
