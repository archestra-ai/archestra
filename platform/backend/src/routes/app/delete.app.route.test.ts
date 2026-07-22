import { ADMIN_ROLE_NAME } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("DELETE /api/apps/:appId", () => {
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

  test("an admin deletes an org-scoped app and it stops being viewable", async ({
    makeApp,
  }) => {
    const created = await makeApp({ organizationId, scope: "org" });

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/apps/${created.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ success: true });

    const got = await app.inject({
      method: "GET",
      url: `/api/apps/${created.id}`,
    });
    expect(got.statusCode).toBe(404);
  });

  test("returns 404 when deleting an unknown app id", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/apps/${crypto.randomUUID()}`,
    });
    expect(response.statusCode).toBe(404);
  });

  test("a plain member cannot delete an org-scoped app (403)", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    const created = await makeApp({ organizationId, scope: "org" });
    const member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    user = member;

    const response = await app.inject({
      method: "DELETE",
      url: `/api/apps/${created.id}`,
    });
    expect(response.statusCode).toBe(403);
  });
});
