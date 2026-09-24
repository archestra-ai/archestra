import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { AppModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("apps bulk routes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { organizationId, user });
    });
    registerAuditLogHook(app);

    const { default: appRoutes } = await import("./app.routes");
    await app.register(appRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const bulkDelete = (ids: unknown) =>
    app.inject({ method: "DELETE", url: "/api/apps/bulk", payload: { ids } });

  describe("DELETE /api/apps/bulk", () => {
    test("soft-deletes every named app and leaves the rest alone", async ({
      makeApp,
    }) => {
      const first = await makeApp({ organizationId });
      const second = await makeApp({ organizationId });
      const kept = await makeApp({ organizationId });

      const response = await bulkDelete([first.id, second.id]);

      expect(response.statusCode).toBe(200);
      expect(response.json().failed).toEqual([]);
      expect(
        response.json().succeeded.map((entry: { id: string }) => entry.id),
      ).toEqual([first.id, second.id]);

      expect(await AppModel.findById(first.id)).toBeNull();
      expect(await AppModel.findById(kept.id)).not.toBeNull();
    });

    /**
     * A locked app is the per-row refusal that makes this different from N
     * deletes: the batch keeps going and says why that one stayed.
     */
    test("refuses a locked app but deletes the rest", async ({ makeApp }) => {
      const locked = await makeApp({
        organizationId,
        name: "Locked App",
        locked: true,
      });
      const ordinary = await makeApp({ organizationId });

      const response = await bulkDelete([locked.id, ordinary.id]);

      expect(response.statusCode).toBe(200);
      expect(
        response.json().succeeded.map((entry: { id: string }) => entry.id),
      ).toEqual([ordinary.id]);
      expect(response.json().failed).toHaveLength(1);
      expect(response.json().failed[0].error).toContain("locked");
      expect(await AppModel.findById(locked.id)).not.toBeNull();
    });

    test("reports an app from another organization as not found", async ({
      makeApp,
      makeOrganization,
    }) => {
      const foreign = await makeApp({
        organizationId: (await makeOrganization()).id,
      });

      const response = await bulkDelete([foreign.id]);

      expect(response.statusCode).toBe(200);
      expect(response.json().failed).toEqual([
        { id: foreign.id, name: null, error: "App not found" },
      ]);
      expect(await AppModel.findById(foreign.id)).not.toBeNull();
    });

    test("rejects an empty batch", async () => {
      expect((await bulkDelete([])).statusCode).toBe(400);
    });

    test("writes one audit record covering the batch", async ({ makeApp }) => {
      const target = await makeApp({
        organizationId,
        name: "Audited App",
      });

      expect((await bulkDelete([target.id])).statusCode).toBe(200);

      const rows = await db
        .select({
          before: schema.auditLogsTable.before,
          after: schema.auditLogsTable.after,
          resourceType: schema.auditLogsTable.resourceType,
        })
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.action, "app.bulk_deleted"),
            eq(schema.auditLogsTable.organizationId, organizationId),
          ),
        );

      expect(rows).toHaveLength(1);
      expect(rows[0].resourceType).toBe("app");
      expect(rows[0].before).toMatchObject({
        apps: [{ id: target.id, name: "Audited App", deleted: false }],
      });
      expect(rows[0].after).toMatchObject({
        apps: [{ id: target.id, deleted: true }],
      });
    });
  });
});
