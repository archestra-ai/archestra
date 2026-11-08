import { vi } from "vitest";
import { auth as betterAuth } from "@/auth/better-auth";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { MemberModel } from "@/models";
import AuditLogModel from "@/models/audit-log";
import LimitModel, { LimitValidationService } from "@/models/limit";
import TeamModel from "@/models/team";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("team routes", () => {
  let app: FastifyInstanceWithZod;
  let adminUser: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    vi.clearAllMocks();
    vi.spyOn(betterAuth.api, "getSession").mockImplementation(
      async () => ({ user: { id: adminUser.id } }) as never,
    );

    adminUser = await makeAdmin();
    const organization = await makeOrganization();
    organizationId = organization.id;
    await makeMember(adminUser.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          user: unknown;
          organizationId: string;
        }
      ).user = adminUser;
      (
        request as typeof request & {
          user: { id: string };
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: teamRoutes } = await import("./team");
    registerAuditLogHook(app);
    await app.register(teamRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("team creation cannot promote a creator into an existing team's budget authority", async ({
    makeTeam,
    makeCustomRole,
    makeTeamMember,
  }) => {
    const target = await makeTeam(organizationId, adminUser.id);
    await makeTeamMember(target.id, adminUser.id, { role: "member" });
    const role = await makeCustomRole(organizationId, {
      role: "team_creator",
      permission: { team: ["create"] },
    });
    await MemberModel.updateRole(adminUser.id, organizationId, role.role);
    const promotion = await app.inject({
      method: "PUT",
      url: `/api/teams/${target.id}/members/${adminUser.id}`,
      payload: { role: "admin" },
    });
    expect(promotion.statusCode, promotion.body).toBe(403);
    const child = await app.inject({
      method: "POST",
      url: "/api/teams",
      payload: { name: "Unauthorized child", parentId: target.id },
    });
    expect(child.statusCode, child.body).toBe(403);
    const promoted = await app.inject({
      method: "POST",
      url: "/api/teams",
      payload: { name: "Unauthorized role", roles: ["admin"] },
    });
    expect(promoted.statusCode, promoted.body).toBe(403);
    expect(
      await TeamModel.getAdministeredTeamIds(adminUser.id, organizationId),
    ).toEqual([]);
  });

  test("persists and audits team role replacement and rejects grants the caller lacks", async ({
    makeTeam,
    makeCustomRole,
  }) => {
    const team = await makeTeam(organizationId, adminUser.id);
    const role = await makeCustomRole(organizationId, {
      role: "log_reader",
      permission: { log: ["read"] },
    });
    const result = await app.inject({
      method: "PUT",
      url: `/api/teams/${team.id}`,
      payload: { roles: [role.role] },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().roles).toEqual([role.role]);
    const audit = await AuditLogModel.findPaginated({
      organizationId,
      limit: 10,
      offset: 0,
      resourceId: team.id,
    });
    expect(audit.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "team.updated",
          before: expect.objectContaining({ roles: [] }),
          after: expect.objectContaining({ roles: [role.role] }),
        }),
      ]),
    );
    await MemberModel.updateRole(adminUser.id, organizationId, "member");
    const denied = await app.inject({
      method: "PUT",
      url: `/api/teams/${team.id}`,
      payload: { roles: ["admin"] },
    });
    expect(denied.statusCode).toBe(403);
  });

  test("checks a team's organization without loading its members", async ({
    makeTeam,
  }) => {
    const team = await makeTeam(organizationId, adminUser.id);
    const doomed = await makeTeam(organizationId, adminUser.id);
    const loadMembers = vi.spyOn(TeamModel, "getTeamMembers");

    const update = await app.inject({
      method: "PUT",
      url: `/api/teams/${team.id}`,
      payload: { name: "Renamed team" },
    });
    expect(update.statusCode, update.body).toBe(200);
    // Only the updated team in the response lists its members.
    expect(loadMembers).toHaveBeenCalledTimes(1);
    loadMembers.mockClear();

    const added = await app.inject({
      method: "POST",
      url: `/api/teams/${team.id}/external-groups`,
      payload: { groupIdentifier: "engineering" },
    });
    expect(added.statusCode, added.body).toBe(200);
    const groups = await app.inject({
      method: "GET",
      url: `/api/teams/${team.id}/external-groups`,
    });
    expect(groups.statusCode, groups.body).toBe(200);
    const removed = await app.inject({
      method: "DELETE",
      url: `/api/teams/${team.id}/external-groups/${added.json().id}`,
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/teams/${doomed.id}`,
    });
    expect(deleted.statusCode, deleted.body).toBe(200);

    expect(loadMembers).not.toHaveBeenCalled();
  });

  test("links a group for one identity provider with a team role, and audits it", async ({
    makeTeam,
    makeIdentityProvider,
    makeOrganization,
  }) => {
    const team = await makeTeam(organizationId, adminUser.id);
    const okta = await makeIdentityProvider(organizationId);
    const elsewhere = await makeIdentityProvider((await makeOrganization()).id);

    const linked = await app.inject({
      method: "POST",
      url: `/api/teams/${team.id}/external-groups`,
      payload: {
        groupIdentifier: "Platform-Leads",
        identityProviderId: okta.id,
        role: "admin",
      },
    });
    expect(linked.statusCode, linked.body).toBe(200);
    expect(linked.json()).toMatchObject({
      groupIdentifier: "platform-leads",
      identityProviderId: okta.id,
      role: "admin",
    });

    // The same group may be linked again for any provider, but not twice
    // for the same one.
    const anyProvider = await app.inject({
      method: "POST",
      url: `/api/teams/${team.id}/external-groups`,
      payload: { groupIdentifier: "platform-leads" },
    });
    expect(anyProvider.statusCode, anyProvider.body).toBe(200);
    expect(anyProvider.json()).toMatchObject({
      identityProviderId: null,
      role: "member",
    });
    const duplicate = await app.inject({
      method: "POST",
      url: `/api/teams/${team.id}/external-groups`,
      payload: {
        groupIdentifier: "platform-leads",
        identityProviderId: okta.id,
      },
    });
    expect(duplicate.statusCode).toBe(409);

    const foreignProvider = await app.inject({
      method: "POST",
      url: `/api/teams/${team.id}/external-groups`,
      payload: { groupIdentifier: "ops", identityProviderId: elsewhere.id },
    });
    expect(foreignProvider.statusCode).toBe(400);

    const audit = await AuditLogModel.findPaginated({
      organizationId,
      limit: 10,
      offset: 0,
      resourceId: team.id,
    });
    expect(audit.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "team.updated",
          after: expect.objectContaining({
            externalGroups: expect.arrayContaining([
              `platform-leads [admin via ${okta.id}]`,
            ]),
          }),
        }),
      ]),
    );
  });

  describe("PUT /api/teams/:id", () => {
    test("a child lead cannot detach or reparent to escape an inherited budget", async ({
      makeTeam,
      makeTeamMember,
      makeAgent,
    }) => {
      const parent = await makeTeam(organizationId, adminUser.id);
      const child = await makeTeam(organizationId, adminUser.id, {
        parentId: parent.id,
      });
      const other = await makeTeam(organizationId, adminUser.id);
      const agent = await makeAgent({ organizationId });
      await makeTeamMember(child.id, adminUser.id, { role: "admin" });
      await MemberModel.updateRole(adminUser.id, organizationId, "member");
      const limit = await LimitModel.create({
        entityType: "team",
        entityId: parent.id,
        limitType: "token_cost",
        limitValue: 1,
      });
      await LimitModel.updateTokenLimitUsage(
        "team",
        parent.id,
        "gpt-4o",
        1_000_000,
        1_000_000,
      );
      await LimitModel.patch(limit.id, { lastCleanup: new Date() });
      for (const parentId of [null, other.id]) {
        const response = await app.inject({
          method: "PUT",
          url: `/api/teams/${child.id}`,
          payload: { parentId },
        });
        expect(response.statusCode, response.body).toBe(403);
        expect(
          await LimitValidationService.checkLimitsBeforeRequest({
            agentId: agent.id,
            billingTeamId: child.id,
            model: "gpt-4o",
          }),
        ).not.toBeNull();
      }
      expect((await TeamModel.findById(child.id))?.parentId).toBe(parent.id);
      await MemberModel.updateRole(adminUser.id, organizationId, "admin");
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/api/teams/${child.id}`,
            payload: { parentId: other.id },
          })
        ).statusCode,
      ).toBe(200);
    });

    test("team admins may edit their own team's metadata without organization-wide team update", async ({
      makeTeam,
      makeTeamMember,
    }) => {
      await MemberModel.updateRole(adminUser.id, organizationId, "member");
      const own = await makeTeam(organizationId, adminUser.id);
      const other = await makeTeam(organizationId, adminUser.id);
      await makeTeamMember(own.id, adminUser.id, { role: "admin" });
      await makeTeamMember(other.id, adminUser.id, { role: "member" });
      const response = await app.inject({
        method: "PUT",
        url: `/api/teams/${own.id}`,
        payload: { name: "Renamed team", description: "Updated team metadata" },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        name: "Renamed team",
        description: "Updated team metadata",
      });
      const audit = await AuditLogModel.findPaginated({
        organizationId,
        resourceId: own.id,
        offset: 0,
        limit: 10,
      });
      expect(audit.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            after: expect.objectContaining({ name: "Renamed team" }),
          }),
        ]),
      );
      const denied = await app.inject({
        method: "PUT",
        url: `/api/teams/${other.id}`,
        payload: { name: "Unauthorized rename" },
      });
      expect(denied.statusCode).toBe(403);
    });
  });
});
