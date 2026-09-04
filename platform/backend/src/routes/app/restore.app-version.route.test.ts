import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { AppModel, AppVersionModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("POST /api/apps/:appId/versions/:version/restore", () => {
  let server: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    server = createFastifyInstance();
    server.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
    registerAuditLogHook(server);

    const { default: appRoutes } = await import("./app.routes");
    await server.register(appRoutes);
  });

  afterEach(async () => {
    await server.close();
  });

  test("copies an old artifact forward and preserves immutable history", async ({
    makeApp,
    makeAppVersion,
  }) => {
    const originalHtml = "<!doctype html><title>original</title>";
    const app = await makeApp({
      organizationId,
      authorId: user.id,
      html: originalHtml,
    });
    await makeAppVersion(app.id, "<!doctype html><title>unwanted edit</title>");

    const response = await restore(app.id, 1, 2);
    expect(response.statusCode).toBe(200);
    expect(response.json().latestVersion).toBe(3);

    const head = await AppVersionModel.findByAppAndVersion(app.id, 3);
    expect(head?.html).toBe(originalHtml);
    expect(
      (await AppVersionModel.listForApp(app.id)).map((row) => row.version),
    ).toEqual([3, 2, 1]);

    const auditRows = await db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "app.updated"),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].before).toMatchObject({ latestVersion: 2 });
    expect(auditRows[0].after).toMatchObject({ latestVersion: 3 });
  });

  test("does not mint a version when the selected artifact is already current", async ({
    makeApp,
  }) => {
    const app = await makeApp({ organizationId, authorId: user.id });

    const response = await restore(app.id, 1, 1);
    expect(response.statusCode).toBe(200);
    expect(response.json().latestVersion).toBe(1);
    expect(await AppVersionModel.listForApp(app.id)).toHaveLength(1);
  });

  test("rejects a stale base version without overwriting the winning edit", async ({
    makeApp,
    makeAppVersion,
  }) => {
    const app = await makeApp({ organizationId, authorId: user.id });
    await makeAppVersion(app.id, "<!doctype html><title>v2</title>");

    const response = await restore(app.id, 1, 1);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.internal_code).toBe("app_version_conflict");
    expect((await AppModel.findById(app.id))?.latestVersion).toBe(2);
  });

  test("refuses to restore a locked app", async ({
    makeApp,
    makeAppVersion,
  }) => {
    const app = await makeApp({ organizationId, authorId: user.id });
    await makeAppVersion(app.id);
    await AppModel.setLocked(app.id, true);

    const response = await restore(app.id, 1, 2);
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain("locked");
    expect((await AppModel.findById(app.id))?.latestVersion).toBe(2);
  });

  test("lists version metadata without returning every HTML artifact", async ({
    makeApp,
    makeAppVersion,
  }) => {
    const app = await makeApp({ organizationId, authorId: user.id });
    await makeAppVersion(app.id);

    const response = await server.inject({
      method: "GET",
      url: `/api/apps/${app.id}/versions/summaries`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(2);
    expect(response.json()[0]).toEqual({
      id: expect.any(String),
      appId: app.id,
      version: 2,
      createdAt: expect.any(String),
    });
    expect(response.body).not.toContain("<!doctype html>");
  });

  function restore(appId: string, version: number, baseVersion: number) {
    return server.inject({
      method: "POST",
      url: `/api/apps/${appId}/versions/${version}/restore`,
      payload: { baseVersion },
    });
  }
});
