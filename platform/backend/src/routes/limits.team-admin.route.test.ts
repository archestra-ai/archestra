import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import LimitModel from "@/models/limit";
import TeamModel from "@/models/team";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import limitsRoutes from "./limits";
import teamRoutes from "./team";

describe("team admin Limits access", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let authMethod: "session" | "api_key";
  beforeEach(async ({ makeUser, makeOrganization, makeMember }) => {
    authMethod = "session";
    user = await makeUser();
    organizationId = (await makeOrganization()).id;
    await makeMember(user.id, organizationId, { role: "member" });
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId, authMethod });
    });
    registerAuditLogHook(app);
    await app.register(limitsRoutes);
    await app.register(teamRoutes);
  });
  afterEach(async () => {
    await app.close();
  });

  test("creating and administering a child retains the parent's allocation authority, but not authority over its own ceiling", async ({
    makeTeam,
    makeTeamMember,
  }) => {
    const parent = await makeTeam(organizationId, user.id);
    const membership = await makeTeamMember(parent.id, user.id, {
      role: "admin",
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/teams",
      payload: { name: "Created child", parentId: parent.id },
    });
    expect(created.statusCode, created.body).toBe(200);
    const childId = created.json().id as string;
    expect(await TeamModel.isUserTeamAdmin(childId, user.id)).toBe(true);
    const parentLimit = await LimitModel.create({
      entityType: "team",
      entityId: parent.id,
      limitType: "token_cost",
      limitValue: 100,
    });
    const childLimit = await app.inject({
      method: "POST",
      url: "/api/limits",
      payload: {
        entityType: "team",
        entityId: childId,
        limitType: "token_cost",
        limitValue: 50,
      },
    });
    expect(childLimit.statusCode, childLimit.body).toBe(200);
    const childLimitId = childLimit.json().id as string;
    for (const [id, expectedStatus] of [
      [parentLimit.id, 404],
      [childLimitId, 200],
    ] as const) {
      const edited = await app.inject({
        method: "PATCH",
        url: `/api/limits/${id}`,
        payload: { limitValue: 75 },
      });
      expect(edited.statusCode, edited.body).toBe(expectedStatus);
      const reset = await app.inject({
        method: "POST",
        url: `/api/limits/${id}/reset`,
      });
      expect(reset.statusCode, reset.body).toBe(expectedStatus);
    }
    expect(await LimitModel.findById(parentLimit.id)).toMatchObject({
      limitValue: 100,
    });
    expect(await LimitModel.findById(childLimitId)).toMatchObject({
      limitValue: 75,
    });

    // Direct child administration alone cannot change its ceiling after losing the parent role.
    await db
      .update(schema.teamMembersTable)
      .set({ role: "member" })
      .where(eq(schema.teamMembersTable.id, membership.id));
    const denied = await app.inject({
      method: "PATCH",
      url: `/api/limits/${childLimitId}`,
      payload: { limitValue: 200 },
    });
    expect(denied.statusCode, denied.body).toBe(403);
  });

  test("leads manage descendant limits including org-set allocations, while own ceilings and unrelated teams are protected", async ({
    makeTeam,
    makeTeamMember,
    makeOrganization,
  }) => {
    const parent = await makeTeam(organizationId, user.id);
    await makeTeamMember(parent.id, user.id, { role: "admin" });
    const child = await makeTeam(organizationId, user.id, {
      parentId: parent.id,
    });
    const grandchild = await makeTeam(organizationId, user.id, {
      parentId: child.id,
    });
    const unrelated = await makeTeam(organizationId, user.id);
    const foreign = await makeTeam((await makeOrganization()).id, user.id);
    const limits = await Promise.all(
      [parent, child, grandchild, unrelated, foreign].map((team) =>
        LimitModel.create({
          entityType: "team",
          entityId: team.id,
          limitType: "token_cost",
          limitValue: 100,
        }),
      ),
    );
    const listed = await app.inject({ method: "GET", url: "/api/limits" });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(
      listed
        .json()
        .map((row: { id: string }) => row.id)
        .sort(),
    ).toEqual(
      limits
        .slice(0, 3)
        .map((limit) => limit.id)
        .sort(),
    );
    for (const limit of limits) {
      const writable =
        limit.entityId === child.id || limit.entityId === grandchild.id;
      const edited = await app.inject({
        method: "PATCH",
        url: `/api/limits/${limit.id}`,
        payload: { limitValue: 200 },
      });
      expect(edited.statusCode, edited.body).toBe(writable ? 200 : 404);
      const reset = await app.inject({
        method: "POST",
        url: `/api/limits/${limit.id}/reset`,
      });
      expect(reset.statusCode, reset.body).toBe(writable ? 200 : 404);
    }
    for (const team of [parent, child, unrelated, foreign]) {
      const created = await app.inject({
        method: "POST",
        url: "/api/limits",
        payload: {
          entityType: "team",
          entityId: team.id,
          limitType: "token_cost",
          limitValue: 50,
        },
      });
      expect(created.statusCode, created.body).toBe(
        team.id === child.id ? 200 : 404,
      );
    }
    const bulk = await app.inject({
      method: "DELETE",
      url: "/api/limits/bulk",
      payload: { ids: limits.map((limit) => limit.id) },
    });
    expect(
      bulk
        .json()
        .succeeded.map((row: { id: string }) => row.id)
        .sort(),
    ).toEqual(
      limits
        .slice(1, 3)
        .map((limit) => limit.id)
        .sort(),
    );
    expect(await LimitModel.findById(limits[0].id)).toMatchObject({
      limitValue: 100,
    });
  });

  test("ordinary members, revoked admins and foreign admins cannot manage allocations", async ({
    makeTeam,
    makeTeamMember,
    makeOrganization,
  }) => {
    const parent = await makeTeam(organizationId, user.id);
    const child = await makeTeam(organizationId, user.id, {
      parentId: parent.id,
    });
    const limit = await LimitModel.create({
      entityType: "team",
      entityId: child.id,
      limitType: "token_cost",
      limitValue: 100,
    });
    const patch = () =>
      app.inject({
        method: "PATCH",
        url: `/api/limits/${limit.id}`,
        payload: { limitValue: 200 },
      });
    expect((await patch()).statusCode).toBe(403);
    await makeTeamMember(parent.id, user.id, { role: "admin" });
    expect((await patch()).statusCode).toBe(200);
    authMethod = "api_key";
    expect((await patch()).statusCode).toBe(403);
    authMethod = "session";
    await db
      .update(schema.teamMembersTable)
      .set({ role: "member" })
      .where(eq(schema.teamMembersTable.teamId, parent.id));
    const foreign = await makeTeam((await makeOrganization()).id, user.id);
    await makeTeamMember(foreign.id, user.id, { role: "admin" });
    expect((await patch()).statusCode).toBe(403);
  });
});
