import { ADMIN_ROLE_NAME } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GET /api/apps/:appId/versions", () => {
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

  test("lists an app's versions newest first", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Versioned", html: "<h1>v1</h1>", scope: "org" },
    });
    const appId = created.json().id as string;
    await app.inject({
      method: "PATCH",
      url: `/api/apps/${appId}`,
      payload: { html: "<h1>v2</h1>" },
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/apps/${appId}/versions`,
    });
    expect(response.statusCode).toBe(200);
    const versions = response.json() as Array<{ version: number }>;
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
  });

  test("returns a specific version by number", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Pinned", html: "<h1>only</h1>", scope: "org" },
    });
    const appId = created.json().id as string;

    const response = await app.inject({
      method: "GET",
      url: `/api/apps/${appId}/versions/1`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      version: 1,
      html: "<h1>only</h1>",
    });
  });

  test("returns 404 for a version the app does not have", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Single", html: "<h1>v1</h1>", scope: "org" },
    });
    const appId = created.json().id as string;

    const response = await app.inject({
      method: "GET",
      url: `/api/apps/${appId}/versions/99`,
    });
    expect(response.statusCode).toBe(404);
  });

  test("a member cannot list versions of another user's personal app", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const personal = await makeApp({
      organizationId,
      scope: "personal",
      authorId: user.id,
    });
    const other = await makeUser();
    await makeMember(other.id, organizationId, { role: "member" });
    user = other;

    const response = await app.inject({
      method: "GET",
      url: `/api/apps/${personal.id}/versions`,
    });
    expect(response.statusCode).toBe(404);
  });
});
