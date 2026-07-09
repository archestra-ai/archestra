import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { AppRenderDiagnosticsModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("POST /api/apps/:appId/diagnostics", () => {
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

  test("stores the snapshot for the session user and rejects a future version", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/apps",
      payload: { name: "Diag", html: "<h1>v1</h1>", scope: "org" },
    });
    const appId = created.json().id as string;

    const posted = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/diagnostics`,
      payload: { version: 1, entries: [{ type: "error", message: "boom" }] },
    });
    expect(posted.statusCode).toBe(200);

    const stored = await AppRenderDiagnosticsModel.getForUser(appId, user.id);
    expect(stored?.entries).toEqual([{ type: "error", message: "boom" }]);

    // a version past the app's head is rejected (can't have rendered yet)
    const future = await app.inject({
      method: "POST",
      url: `/api/apps/${appId}/diagnostics`,
      payload: { version: 99, entries: [] },
    });
    expect(future.statusCode).toBe(400);
  });

  test("404s for an app the caller cannot see, and stores nothing", async ({
    makeApp,
    makeUser,
    makeMember,
  }) => {
    // a personal app owned by the author is invisible to another member
    const personalApp = await makeApp({
      organizationId,
      scope: "personal",
      authorId: user.id,
    });
    const other = await makeUser();
    await makeMember(other.id, organizationId, { role: "member" });
    user = other;

    const posted = await app.inject({
      method: "POST",
      url: `/api/apps/${personalApp.id}/diagnostics`,
      payload: { version: 1, entries: [] },
    });
    expect(posted.statusCode).toBe(404);
    expect(
      await AppRenderDiagnosticsModel.getForUser(personalApp.id, other.id),
    ).toBeNull();
  });
});
