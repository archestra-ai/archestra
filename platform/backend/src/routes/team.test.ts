import { vi } from "vitest";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { MemberModel } from "@/models";
import AuditLogModel from "@/models/audit-log";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

describe("team routes", () => {
  let app: FastifyInstanceWithZod;
  let adminUser: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    vi.clearAllMocks();
    vi.mocked(hasPermission).mockResolvedValue({ success: true, error: null });

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

  describe("PUT /api/teams/:id", () => {
    test("team admins may edit their own team's metadata without organization-wide team update", async ({
      makeTeam,
      makeTeamMember,
    }) => {
      await MemberModel.updateRole(adminUser.id, organizationId, "member");
      vi.mocked(hasPermission).mockResolvedValue({
        success: false,
        error: null,
      });
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
