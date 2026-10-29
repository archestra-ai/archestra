import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { BrowserStorageStateModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("DELETE /api/browser-storage-states/:userId", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let admin: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    admin = await makeUser();
    await makeMember(admin.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user: admin, organizationId });
    });
    registerAuditLogHook(app);
    const { default: routes } = await import("./browser-storage-state.routes");
    await app.register(routes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("signs a member out and records it in the audit log", async ({
    makeUser,
    makeMember,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId);
    await BrowserStorageStateModel.upsert(
      member.id,
      JSON.stringify({
        cookies: [{ name: "sid", value: "secret", domain: ".example.com" }],
      }),
    );

    const response = await app.inject({
      method: "DELETE",
      url: `/api/browser-storage-states/${member.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(await BrowserStorageStateModel.get(member.id)).toBeNull();

    const rows = await db
      .select({
        resourceId: schema.auditLogsTable.resourceId,
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "browserStorageState.deleted"),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resourceId: member.id,
      before: { userId: member.id, siteCount: 1 },
    });
    expect(JSON.stringify(rows[0])).not.toContain("secret");
  });

  test("cannot sign out a user of another organization", async ({
    makeUser,
    makeOrganization,
    makeMember,
  }) => {
    const outsider = await makeUser();
    await makeMember(outsider.id, (await makeOrganization()).id);
    await BrowserStorageStateModel.upsert(outsider.id, "{}");

    const response = await app.inject({
      method: "DELETE",
      url: `/api/browser-storage-states/${outsider.id}`,
    });

    expect(response.statusCode).toBe(404);
    expect(await BrowserStorageStateModel.get(outsider.id)).toBe("{}");
  });
});
