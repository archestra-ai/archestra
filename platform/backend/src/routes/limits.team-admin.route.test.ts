import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import LimitModel from "@/models/limit";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import limitsRoutes from "./limits";

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
  });
  afterEach(async () => {
    await app.close();
  });

  test("direct team admins reuse CRUD and labels, without reading or mutating sibling, ancestor or organization limits", async ({
    makeTeam,
    makeTeamMember,
  }) => {
    const parent = await makeTeam(organizationId, user.id);
    const mine = await makeTeam(organizationId, user.id, {
      parentId: parent.id,
    });
    const sibling = await makeTeam(organizationId, user.id);
    await makeTeamMember(mine.id, user.id, { role: "admin" });
    await makeTeamMember(sibling.id, user.id, { role: "member" });
    const hidden = await LimitModel.create({
      entityType: "team",
      entityId: sibling.id,
      limitType: "token_cost",
      limitValue: 800,
      labels: [{ key: "private-owner", value: "restricted" }],
    });
    const parentLimit = await LimitModel.create({
      entityType: "team",
      entityId: parent.id,
      limitType: "token_cost",
      limitValue: 900,
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/limits",
      payload: {
        entityType: "team",
        entityId: mine.id,
        limitType: "token_cost",
        limitValue: 100,
        labels: [{ key: "owner", value: "platform" }],
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const id = created.json().id;
    const listed = await app.inject({ method: "GET", url: "/api/limits" });
    expect(listed.json().map((row: { id: string }) => row.id)).toEqual([id]);
    const keys = await app.inject({
      method: "GET",
      url: "/api/limits/labels/keys",
    });
    expect(keys.json()).toEqual(["owner"]);
    for (const other of [hidden, parentLimit]) {
      for (const method of ["GET", "PATCH", "DELETE"] as const) {
        const response = await app.inject({
          method,
          url: `/api/limits/${other.id}`,
          ...(method === "PATCH" ? { payload: { limitValue: 9999 } } : {}),
        });
        expect(response.statusCode, response.body).toBe(404);
      }
    }
    const organization = await app.inject({
      method: "POST",
      url: "/api/limits",
      payload: {
        entityType: "organization",
        entityId: organizationId,
        limitType: "token_cost",
        limitValue: 100,
      },
    });
    expect(organization.statusCode).toBe(404);
    const edited = await app.inject({
      method: "PATCH",
      url: `/api/limits/${id}`,
      payload: { limitValue: 150 },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const bulk = await app.inject({
      method: "DELETE",
      url: "/api/limits/bulk",
      payload: { ids: [id, hidden.id] },
    });
    expect(
      bulk.json().succeeded.map((item: { id: string }) => item.id),
    ).toEqual([id]);
    expect(bulk.json().failed).toHaveLength(1);
    expect(await LimitModel.findById(hidden.id)).not.toBeNull();
  });

  test("team admins see an organization-set limit on their team but cannot change or delete it", async ({
    makeTeam,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, user.id);
    await makeTeamMember(team.id, user.id, { role: "admin" });
    const orgSet = await LimitModel.create({
      entityType: "team",
      entityId: team.id,
      limitType: "token_cost",
      limitValue: 100,
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/limits",
      payload: {
        entityType: "team",
        entityId: team.id,
        limitType: "token_cost",
        limitValue: 50,
        teamManaged: false,
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().teamManaged).toBe(true);

    const listed = await app.inject({ method: "GET", url: "/api/limits" });
    expect(
      Object.fromEntries(
        listed
          .json()
          .map((row: { id: string; teamManaged: boolean }) => [
            row.id,
            row.teamManaged,
          ]),
      ),
    ).toEqual({ [orgSet.id]: false, [created.json().id]: true });
    for (const method of ["PATCH", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: `/api/limits/${orgSet.id}`,
        ...(method === "PATCH" ? { payload: { limitValue: 1_000_000 } } : {}),
      });
      expect(response.statusCode, response.body).toBe(403);
    }
    const bulk = await app.inject({
      method: "DELETE",
      url: "/api/limits/bulk",
      payload: { ids: [orgSet.id] },
    });
    expect(bulk.json().succeeded).toEqual([]);
    expect(await LimitModel.findById(orgSet.id)).toMatchObject({
      limitValue: 100,
    });
  });

  test("an ordinary member is denied; demotion removes access immediately; another org's admin membership grants nothing", async ({
    makeTeam,
    makeTeamMember,
    makeOrganization,
  }) => {
    expect(
      (await app.inject({ method: "GET", url: "/api/limits" })).statusCode,
    ).toBe(403);
    const team = await makeTeam(organizationId, user.id);
    await makeTeamMember(team.id, user.id, { role: "admin" });
    expect(
      (await app.inject({ method: "GET", url: "/api/limits" })).statusCode,
    ).toBe(200);
    authMethod = "api_key";
    expect(
      (await app.inject({ method: "GET", url: "/api/limits" })).statusCode,
    ).toBe(403);
    authMethod = "session";
    await db
      .update(schema.teamMembersTable)
      .set({ role: "member" })
      .where(eq(schema.teamMembersTable.teamId, team.id));
    const foreign = await makeTeam((await makeOrganization()).id, user.id);
    await makeTeamMember(foreign.id, user.id, { role: "admin" });
    expect(
      (await app.inject({ method: "GET", url: "/api/limits" })).statusCode,
    ).toBe(403);
  });

  test("team admins reset only the spend limits they set on their own team", async ({
    makeTeam,
    makeTeamMember,
  }) => {
    const team = await makeTeam(organizationId, user.id);
    const other = await makeTeam(organizationId, user.id);
    await makeTeamMember(team.id, user.id, { role: "admin" });
    const reset = (id: string) =>
      app.inject({ method: "POST", url: `/api/limits/${id}/reset` });
    const orgSet = await LimitModel.create({
      entityType: "team",
      entityId: team.id,
      limitType: "token_cost",
      limitValue: 100,
    });
    const otherTeam = await LimitModel.create({
      entityType: "team",
      entityId: other.id,
      limitType: "token_cost",
      limitValue: 100,
    });
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
    expect(created.statusCode, created.body).toBe(200);

    expect((await reset(created.json().id)).statusCode).toBe(200);
    expect((await reset(orgSet.id)).statusCode).toBe(403);
    expect((await reset(otherTeam.id)).statusCode).toBe(404);
    await db
      .update(schema.teamMembersTable)
      .set({ role: "member" })
      .where(eq(schema.teamMembersTable.teamId, team.id));
    expect((await reset(created.json().id)).statusCode).toBe(403);
  });
});
