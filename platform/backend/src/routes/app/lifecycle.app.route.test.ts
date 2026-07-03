import { ADMIN_ROLE_NAME } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("/api/apps lifecycle (create → get → list → update → delete)", () => {
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

  test("an org-scoped app flows create → get → list → update (forks a version) → delete", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Dashboard", html: "<h1>v1</h1>", scope: "org" },
    });
    expect(created.statusCode).toBe(200);
    const appId = created.json().id as string;
    expect(created.json().latestVersion).toBe(1);

    const got = await app.inject({ method: "GET", url: `/api/apps/${appId}` });
    expect(got.statusCode).toBe(200);
    expect(got.json().name).toBe("Dashboard");

    const listed = await app.inject({ method: "GET", url: "/api/apps" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().data.map((a: { id: string }) => a.id)).toContain(
      appId,
    );
    expect(listed.json().pagination.total).toBeGreaterThanOrEqual(1);

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/apps/${appId}`,
      payload: { html: "<h1>v2</h1>" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().latestVersion).toBe(2);

    const versions = await app.inject({
      method: "GET",
      url: `/api/apps/${appId}/versions`,
    });
    expect(versions.statusCode).toBe(200);
    expect(versions.json()).toHaveLength(2);

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/apps/${appId}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().success).toBe(true);
  });
});
