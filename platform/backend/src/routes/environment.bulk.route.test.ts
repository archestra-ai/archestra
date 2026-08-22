import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { EnvironmentModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import environmentRoutes from "./environment";

describe("DELETE /api/environments/bulk", () => {
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
    await app.register(environmentRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  const createEnv = async (name: string) =>
    (
      await app.inject({
        method: "POST",
        url: "/api/environments",
        payload: { name },
      })
    ).json();

  const bulkDelete = (ids: unknown) =>
    app.inject({
      method: "DELETE",
      url: "/api/environments/bulk",
      payload: { ids },
    });

  test("deletes every named environment and leaves the rest alone", async () => {
    const first = await createEnv("bulk-env-a");
    const second = await createEnv("bulk-env-b");
    const kept = await createEnv("bulk-env-kept");

    const response = await bulkDelete([first.id, second.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      succeeded: [
        { id: first.id, name: "bulk-env-a" },
        { id: second.id, name: "bulk-env-b" },
      ],
      failed: [],
    });

    const remaining =
      await EnvironmentModel.listForOrganization(organizationId);
    expect(remaining.map((environment) => environment.id)).toContain(kept.id);
    expect(remaining.map((environment) => environment.id)).not.toContain(
      first.id,
    );
  });

  /**
   * The reason this resource earns its own per-row failure path: an
   * environment still holding catalog items refuses deletion with a 409, and
   * in a batch that has to be this row's problem, not the batch's status.
   */
  test("refuses an environment that still has catalog items, and deletes the rest", async ({
    makeInternalMcpCatalog,
  }) => {
    const inUse = await createEnv("bulk-env-in-use");
    const free = await createEnv("bulk-env-free");
    await makeInternalMcpCatalog({
      organizationId,
      environmentId: inUse.id,
      name: "still-here",
    });

    const response = await bulkDelete([inUse.id, free.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json().succeeded).toEqual([
      { id: free.id, name: "bulk-env-free" },
    ]);
    expect(response.json().failed).toHaveLength(1);
    expect(response.json().failed[0]).toMatchObject({
      id: inUse.id,
      name: "bulk-env-in-use",
    });
    expect(response.json().failed[0].error).toContain(
      "still has 1 catalog item",
    );

    expect(
      await EnvironmentModel.findByIdForOrganization(inUse.id, organizationId),
    ).not.toBeNull();
  });

  test("reports an environment from another organization as not found", async ({
    makeOrganization,
  }) => {
    const otherOrgId = (await makeOrganization()).id;
    const foreign = await EnvironmentModel.create({
      name: "theirs",
      organizationId: otherOrgId,
    });

    const response = await bulkDelete([foreign.id]);

    expect(response.statusCode).toBe(200);
    expect(response.json().failed).toEqual([
      { id: foreign.id, name: null, error: "Environment not found" },
    ]);
    expect(
      await EnvironmentModel.findByIdForOrganization(foreign.id, otherOrgId),
    ).not.toBeNull();
  });

  test("rejects an empty batch", async () => {
    expect((await bulkDelete([])).statusCode).toBe(400);
  });

  test("writes one audit record covering the batch", async () => {
    const environment = await createEnv("audited-env");

    expect((await bulkDelete([environment.id])).statusCode).toBe(200);

    const rows = await db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
        resourceType: schema.auditLogsTable.resourceType,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "environment.bulk_deleted"),
          eq(schema.auditLogsTable.organizationId, organizationId),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0].resourceType).toBe("environment");
    expect(rows[0].before).toMatchObject({
      environments: [{ id: environment.id, name: "audited-env" }],
    });
    expect(rows[0].after).toMatchObject({ environments: [] });
  });
});
