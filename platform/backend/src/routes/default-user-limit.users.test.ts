import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import {
  AuditLogModel,
  EnvironmentDefaultUserLimitModel,
  EnvironmentModel,
  LimitModel,
  LimitValidationService,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User, UserLimitUsage } from "@/types";

describe("user limit usage routes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let admin: User;
  let agentId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember, makeAgent }) => {
    organizationId = (await makeOrganization()).id;
    admin = await makeAdmin({ name: "Admin" });
    await makeMember(admin.id, organizationId, { role: "admin" });
    agentId = (await makeAgent({ organizationId })).id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { organizationId, user: admin });
    });
    registerAuditLogHook(app);
    const { default: defaultUserLimitRoutes } = await import(
      "./default-user-limit"
    );
    await app.register(defaultUserLimitRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const list = async (query = "") => {
    const response = await app.inject({
      method: "GET",
      url: `/api/default-user-limits/users${query}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      data: UserLimitUsage[];
      pagination: { total: number; hasNext: boolean };
      summary: Record<string, number>;
    };
  };

  test("ranks users by how close they are to the limit that applies to them", async ({
    makeUser,
    makeMember,
    makeInteraction,
  }) => {
    await EnvironmentDefaultUserLimitModel.create({
      organizationId,
      environmentId: null,
      limitValue: 10,
      cleanupInterval: "calendar_month",
    });
    const blocked = await member({ makeUser, makeMember }, "Blocked Bea");
    const close = await member({ makeUser, makeMember }, "Close Cal");
    const custom = await member({ makeUser, makeMember }, "Custom Cy");
    await makeInteraction(agentId, { userId: blocked.id, cost: "12" });
    await makeInteraction(agentId, { userId: close.id, cost: "8" });
    await makeInteraction(agentId, { userId: custom.id, cost: "50" });
    const customLimit = await LimitModel.create({
      entityType: "user",
      entityId: custom.id,
      limitType: "token_cost",
      limitValue: 100,
      cleanupInterval: "calendar_month",
      reason: "Runs the nightly eval suite",
    });

    const body = await list();

    expect(body.data.map((row) => row.name)).toEqual([
      "Blocked Bea",
      "Close Cal",
      "Admin",
      "Custom Cy",
    ]);
    expect(body.data[0]).toMatchObject({
      source: "organization_default",
      limitValue: 10,
      spent: 12,
      status: "at",
    });
    expect(body.data[1]).toMatchObject({ spent: 8, status: "near" });
    // A custom limit replaces the default, so the $50 is not counted against $10.
    expect(body.data[3]).toMatchObject({
      source: "custom",
      limitValue: 100,
      customLimitId: customLimit.id,
      customReason: "Runs the nightly eval suite",
      spent: 0,
      // What counts against the default if the custom limit is removed.
      fallbackSpent: 50,
    });
    expect(body.summary).toMatchObject({
      total: 4,
      at: 1,
      near: 1,
      custom: 1,
      none: 0,
      organizationDefault: 3,
      flaggedCustom: 0,
    });
  });

  test("shows an environment override where it is closer to blocking the user", async ({
    makeUser,
    makeMember,
    makeInteraction,
  }) => {
    const production = await EnvironmentModel.create({
      organizationId,
      name: "Production",
    });
    await EnvironmentDefaultUserLimitModel.create({
      organizationId,
      environmentId: null,
      limitValue: 100,
    });
    await EnvironmentDefaultUserLimitModel.create({
      organizationId,
      environmentId: production.id,
      limitValue: 5,
    });
    const user = await member({ makeUser, makeMember }, "Prod Pat");
    const interaction = await makeInteraction(agentId, {
      userId: user.id,
      cost: "4",
    });
    await db
      .update(schema.interactionsTable)
      .set({ environmentId: production.id })
      .where(eq(schema.interactionsTable.id, interaction.id));

    const all = await list();
    expect(all.data[0]).toMatchObject({
      name: "Prod Pat",
      source: "environment_default",
      environmentId: production.id,
      environmentName: "Production",
      limitValue: 5,
      spent: 4,
      status: "near",
    });

    expect(all.summary.environments).toEqual([
      { environmentId: production.id, users: 1, at: 0, near: 1 },
    ]);

    // Filtered to the environment: only people who spent there.
    const inProduction = await list(`?environmentId=${production.id}`);
    expect(inProduction.data.map((row) => row.name)).toEqual(["Prod Pat"]);
  });

  test("lists users with no limit when no default applies", async ({
    makeUser,
    makeMember,
    makeInteraction,
  }) => {
    const user = await member({ makeUser, makeMember }, "Free Fran");
    await makeInteraction(agentId, { userId: user.id, cost: "3.5" });

    const body = await list("?status=none&search=fran");

    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      name: "Free Fran",
      source: "none",
      limitValue: null,
      percent: null,
      spent: 3.5,
      status: "ok",
    });
    expect(body.summary).toMatchObject({ total: 1, none: 1 });
  });

  test("pages through users", async ({ makeUser, makeMember }) => {
    for (const name of ["Ana", "Ben", "Cleo"]) {
      await member({ makeUser, makeMember }, name);
    }

    const first = await list("?limit=2&offset=0");
    const second = await list("?limit=2&offset=2");

    expect(first.pagination).toMatchObject({ total: 4, hasNext: true });
    expect([...first.data, ...second.data].map((row) => row.name)).toEqual([
      "Admin",
      "Ana",
      "Ben",
      "Cleo",
    ]);
  });

  test("a reset lets a blocked user through again and is audited", async ({
    makeUser,
    makeMember,
    makeInteraction,
  }) => {
    await EnvironmentDefaultUserLimitModel.create({
      organizationId,
      environmentId: null,
      limitValue: 10,
    });
    const user = await member({ makeUser, makeMember }, "Blocked Bea");
    await makeInteraction(agentId, {
      userId: user.id,
      cost: "12",
      createdAt: new Date(Date.now() - 60_000),
    });
    expect(
      await LimitValidationService.checkLimitsBeforeRequest({
        agentId,
        userId: user.id,
      }),
    ).not.toBeNull();

    const response = await app.inject({
      method: "POST",
      url: `/api/default-user-limits/users/${user.id}/reset`,
    });

    expect(response.statusCode).toBe(200);
    expect(
      await LimitValidationService.checkLimitsBeforeRequest({
        agentId,
        userId: user.id,
      }),
    ).toBeNull();
    const [row] = (await list("?search=bea")).data;
    expect(row).toMatchObject({ spent: 0, status: "ok" });
    expect(row.lastResetAt).not.toBeNull();
    expect(row.lastResetByName).toBe("Admin");

    const audit = await AuditLogModel.findPaginated({
      organizationId,
      resourceId: user.id,
      action: "userLimitUsage.reset",
      limit: 10,
      offset: 0,
    });
    expect(audit.data).toHaveLength(1);
    expect(audit.data[0].before).toMatchObject({ resetAt: null });
    expect(audit.data[0].after).toMatchObject({ resetByUserId: admin.id });
  });

  test("a reset zeroes a custom limit's usage", async ({
    makeUser,
    makeMember,
  }) => {
    const user = await member({ makeUser, makeMember }, "Custom Cy");
    const limit = await LimitModel.create({
      entityType: "user",
      entityId: user.id,
      limitType: "token_cost",
      limitValue: 100,
      model: ["gpt-4o"],
    });
    await db
      .update(schema.limitModelUsageTable)
      .set({ currentUsageTokensIn: 1_000_000 })
      .where(eq(schema.limitModelUsageTable.limitId, limit.id));

    const response = await app.inject({
      method: "POST",
      url: `/api/default-user-limits/users/${user.id}/reset`,
    });

    expect(response.statusCode).toBe(200);
    const [usage] = await LimitModel.getRawModelUsage(limit.id);
    expect(usage.currentUsageTokensIn).toBe(0);
  });

  test("returns 404 when resetting someone outside the organization", async ({
    makeUser,
  }) => {
    const outsider = await makeUser();

    const response = await app.inject({
      method: "POST",
      url: `/api/default-user-limits/users/${outsider.id}/reset`,
    });

    expect(response.statusCode).toBe(404);
  });

  async function member(
    fixtures: {
      makeUser: (overrides?: { name?: string }) => Promise<User>;
      makeMember: (userId: string, organizationId: string) => Promise<unknown>;
    },
    name: string,
  ) {
    const user = await fixtures.makeUser({ name });
    await fixtures.makeMember(user.id, organizationId);
    return user;
  }
});
