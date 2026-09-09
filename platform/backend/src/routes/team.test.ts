import { vi } from "vitest";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { MemberModel, OrganizationModel } from "@/models";
import AuditLogModel from "@/models/audit-log";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

import { hasPermission } from "@/auth";

describe("team route TOON compression contract", () => {
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

  describe("POST /api/teams", () => {
    test("persists convertToolResultsToToon=true when org scope is 'team'", async () => {
      await OrganizationModel.patch(organizationId, {
        compressionScope: "team",
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/teams",
        payload: {
          name: "Team With TOON",
          convertToolResultsToToon: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().convertToolResultsToToon).toBe(true);
    });

    test("persists convertToolResultsToToon=true even when org scope is 'organization'", async () => {
      // Default compressionScope is 'organization'. The team-level opt-in is
      // stored (and honored at runtime) regardless of the org scope, so a
      // client can create the team before flipping the org scope (#4454).
      const response = await app.inject({
        method: "POST",
        url: "/api/teams",
        payload: {
          name: "TOON Before Scope Change",
          convertToolResultsToToon: true,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.convertToolResultsToToon).toBe(true);

      // The flag survived to storage, not just the create response echo.
      const fetched = await app.inject({
        method: "GET",
        url: `/api/teams/${body.id}`,
      });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.json().convertToolResultsToToon).toBe(true);
    });

    test("accepts omitted convertToolResultsToToon and defaults to false", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/teams",
        payload: { name: "No TOON Field" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().convertToolResultsToToon).toBe(false);
    });

    test("accepts convertToolResultsToToon=false regardless of org scope", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/teams",
        payload: {
          name: "Explicit False TOON",
          convertToolResultsToToon: false,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().convertToolResultsToToon).toBe(false);
    });
  });

  describe("PUT /api/teams/:id", () => {
    test("persists convertToolResultsToToon=true even when org scope is 'organization'", async ({
      makeTeam,
    }) => {
      const team = await makeTeam(organizationId, adminUser.id);

      const response = await app.inject({
        method: "PUT",
        url: `/api/teams/${team.id}`,
        payload: { convertToolResultsToToon: true },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().convertToolResultsToToon).toBe(true);
    });

    test("persists convertToolResultsToToon=true when org scope is 'team'", async ({
      makeTeam,
    }) => {
      await OrganizationModel.patch(organizationId, {
        compressionScope: "team",
      });
      const team = await makeTeam(organizationId, adminUser.id);

      const response = await app.inject({
        method: "PUT",
        url: `/api/teams/${team.id}`,
        payload: { convertToolResultsToToon: true },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().convertToolResultsToToon).toBe(true);
    });
  });
});
