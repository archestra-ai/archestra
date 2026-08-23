import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import ServiceAccountModel from "@/models/service-account";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import serviceAccountRoutes from "./service-account";

describe("DELETE /api/service-accounts/bulk", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    await app.register(serviceAccountRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const createAccount = async (name: string) =>
    (
      await app.inject({
        method: "POST",
        url: "/api/service-accounts",
        payload: { name, role: MEMBER_ROLE_NAME },
      })
    ).json();

  const bulkDelete = (ids: unknown) =>
    app.inject({
      method: "DELETE",
      url: "/api/service-accounts/bulk",
      payload: { ids },
    });

  test("deletes every named account and leaves the rest alone", async () => {
    const first = await createAccount("bulk-sa-a");
    const second = await createAccount("bulk-sa-b");
    const kept = await createAccount("bulk-sa-kept");

    const response = await bulkDelete([first.id, second.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [
        { id: first.id, name: "bulk-sa-a" },
        { id: second.id, name: "bulk-sa-b" },
      ],
      failed: [],
    });

    const remaining =
      await ServiceAccountModel.listByOrganizationId(organizationId);
    expect(remaining.map((account) => account.id)).toEqual([kept.id]);
  });

  test("reports an account from another organization as not found and leaves it standing", async ({
    makeOrganization,
  }) => {
    const mine = await createAccount("mine");
    const otherOrgId = (await makeOrganization()).id;
    const foreign = await ServiceAccountModel.create({
      name: "theirs",
      role: MEMBER_ROLE_NAME,
      organizationId: otherOrgId,
    });

    const response = await bulkDelete([mine.id, foreign.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [{ id: mine.id, name: "mine" }],
      failed: [
        { id: foreign.id, name: null, error: "Service account not found" },
      ],
    });
    expect(
      await ServiceAccountModel.findById(foreign.id, otherOrgId),
    ).not.toBeNull();
  });

  test("collapses duplicate ids", async () => {
    const account = await createAccount("dupe");

    const response = await bulkDelete([account.id, account.id]);

    expect(response.json().succeeded).toEqual([
      { id: account.id, name: "dupe" },
    ]);
  });

  test("rejects an empty batch", async () => {
    expect((await bulkDelete([])).statusCode).toBe(400);
  });

  test("rejects a batch over the cap", async () => {
    const ids = Array.from({ length: 501 }, () => crypto.randomUUID());
    expect((await bulkDelete(ids)).statusCode).toBe(400);
  });

  test("writes one audit record naming what the batch removed", async () => {
    const account = await createAccount("audited-sa");

    expect((await bulkDelete([account.id])).statusCode).toBe(200);

    const rows = await db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
        resourceType: schema.auditLogsTable.resourceType,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "serviceAccount.bulk_deleted"),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].resourceType).toBe("serviceAccount");
    expect(rows[0].before).toMatchObject({
      serviceAccounts: [{ id: account.id, name: "audited-sa" }],
    });
    // Gone by the time the "after" side is read, which is what makes the diff
    // say a deletion happened rather than nothing at all.
    expect(rows[0].after).toMatchObject({ serviceAccounts: [] });
  });
});
