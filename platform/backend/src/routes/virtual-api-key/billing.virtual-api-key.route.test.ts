import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import LimitModel from "@/models/limit";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("virtual key billing team and spend cap", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let caller: User;

  beforeEach(async ({ makeOrganization }) => {
    organizationId = (await makeOrganization()).id;
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user: caller, organizationId });
    });
    registerAuditLogHook(app);
    const { default: virtualApiKeysRoutes } = await import(
      "./virtual-api-key.routes"
    );
    await app.register(virtualApiKeysRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  const createKey = (payload: Record<string, unknown>) =>
    app.inject({
      method: "POST",
      url: "/api/llm-virtual-keys",
      payload: { name: "ci", keyType: "passthrough", ...payload },
    });

  test("a team admin bills their team and caps the key", async ({
    makeMember,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: "member" });
    const team = await makeTeam(organizationId, caller.id, {
      name: "Platform",
    });
    await makeTeamMember(team.id, caller.id, { role: "admin" });

    const response = await createKey({
      billingTeamId: team.id,
      spendCap: { limitValue: 500, cleanupInterval: "calendar_month" },
    });

    expect(response.statusCode).toBe(200);
    const key = response.json();
    expect(key.billingTeam).toEqual({ id: team.id, name: "Platform" });
    expect(key.spendCap).toMatchObject({
      limitValue: 500,
      cleanupInterval: "calendar_month",
      currentUsage: 0,
    });
    // The cap is an ordinary limit, so it shows on the limits page too.
    expect(await LimitModel.findAll("virtual_key", key.id)).toHaveLength(1);
  });

  test("a member cannot bill a team they do not administer", async ({
    makeMember,
    makeTeam,
    makeTeamMember,
    makeUser,
  }) => {
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: "member" });
    const team = await makeTeam(organizationId, caller.id);
    await makeTeamMember(team.id, caller.id, { role: "member" });

    const response = await createKey({ billingTeamId: team.id });

    expect(response.statusCode).toBe(403);
  });

  test("a key owner cannot change a cap without permission to manage limits", async ({
    makeMember,
    makeUser,
  }) => {
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: "member" });
    const created = (
      await createKey({
        spendCap: { limitValue: 100, cleanupInterval: "calendar_month" },
      })
    ).json();

    const raise = await app.inject({
      method: "PATCH",
      url: `/api/llm-virtual-keys/${created.id}`,
      payload: {
        name: "ci",
        keyType: "passthrough",
        spendCap: { limitValue: 10_000, cleanupInterval: "calendar_month" },
      },
    });
    const remove = await app.inject({
      method: "PATCH",
      url: `/api/llm-virtual-keys/${created.id}`,
      payload: { name: "ci", keyType: "passthrough", spendCap: null },
    });

    expect(raise.statusCode).toBe(403);
    expect(remove.statusCode).toBe(403);
  });

  test("an admin changes the billing team and cap, and the audit record shows it", async ({
    makeMember,
    makeTeam,
    makeUser,
  }) => {
    caller = await makeUser();
    await makeMember(caller.id, organizationId, { role: "admin" });
    const team = await makeTeam(organizationId, caller.id);
    const created = (await createKey({})).json();

    const response = await app.inject({
      method: "PATCH",
      url: `/api/llm-virtual-keys/${created.id}`,
      payload: {
        name: "ci",
        keyType: "passthrough",
        billingTeamId: team.id,
        spendCap: { limitValue: 250, cleanupInterval: "1w" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      billingTeam: { id: team.id },
      spendCap: { limitValue: 250, cleanupInterval: "1w" },
    });
    const [audit] = await db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.resourceType, "virtualApiKey"),
          eq(schema.auditLogsTable.resourceId, created.id),
          eq(schema.auditLogsTable.organizationId, organizationId),
          eq(schema.auditLogsTable.httpMethod, "PATCH"),
        ),
      );
    expect(audit.before).toMatchObject({ billingTeamId: null, spendCap: null });
    expect(audit.after).toMatchObject({
      billingTeamId: team.id,
      spendCap: { limitValue: 250, cleanupInterval: "1w" },
    });
  });
});
