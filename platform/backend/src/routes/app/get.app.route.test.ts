import { ADMIN_ROLE_NAME } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("GET /api/apps/:appId", () => {
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

  test("returns an org-scoped app the caller may view", async ({ makeApp }) => {
    const created = await makeApp({
      organizationId,
      scope: "org",
      name: "Viewable",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/apps/${created.id}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: created.id, name: "Viewable" });
    expect(response.json().teams).toEqual([]);
  });

  test("returns the app's assigned teams (id + name)", async ({
    makeTeam,
    makeApp,
  }) => {
    const team = await makeTeam(organizationId, user.id, { name: "Design" });
    const created = await makeApp({
      organizationId,
      scope: "team",
      authorId: user.id,
      teamIds: [team.id],
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/apps/${created.id}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().teams).toEqual([{ id: team.id, name: "Design" }]);
  });

  test("returns 404 for an unknown app id", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/apps/${crypto.randomUUID()}`,
    });
    expect(response.statusCode).toBe(404);
  });

  test("a user cannot GET an app belonging to another organization", async ({
    makeOrganization,
    makeApp,
  }) => {
    const otherOrg = await makeOrganization();
    const appInOther = await makeApp({
      organizationId: otherOrg.id,
      scope: "org",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/apps/${appInOther.id}`,
    });
    expect(response.statusCode).toBe(404);
  });

  test("a member cannot GET another user's personal app (no existence leak)", async ({
    makeUser,
    makeMember,
    makeApp,
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
      url: `/api/apps/${personal.id}`,
    });
    expect(response.statusCode).toBe(404);
  });
});
