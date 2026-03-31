import { vi } from "vitest";
import type * as originalConfigModule from "@/config";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const { hasPermissionMock } = vi.hoisted(() => ({
  hasPermissionMock: vi.fn(),
}));

vi.mock("@/auth", async () => {
  const actual = await vi.importActual<typeof import("@/auth")>("@/auth");
  return {
    ...actual,
    hasPermission: hasPermissionMock,
  };
});

vi.mock("@/config", async (importOriginal) => {
  const actual = await importOriginal<typeof originalConfigModule>();
  return {
    default: {
      ...actual.default,
      enterpriseFeatures: {
        ...actual.default.enterpriseFeatures,
        core: true,
      },
    },
  };
});

describe("team routes", () => {
  let app: FastifyInstanceWithZod;
  let adminUser: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeMember, makeOrganization }) => {
    vi.clearAllMocks();
    hasPermissionMock.mockResolvedValue({ success: true });

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
    await app.register(teamRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  // ===================================================================
  // Team Visibility by Role
  // ===================================================================

  describe("team visibility by role", () => {
    test("admin sees all teams in the organization", async ({ makeTeam }) => {
      const _teamA = await makeTeam(organizationId, adminUser.id, {
        name: "Engineering",
      });
      const _teamB = await makeTeam(organizationId, adminUser.id, {
        name: "Marketing",
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/teams",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const names = body.data.map((t: { name: string }) => t.name);
      expect(names).toContain("Engineering");
      expect(names).toContain("Marketing");
    });

    test("member only sees teams they belong to", async ({
      makeTeam,
      makeUser,
      makeMember,
      makeTeamMember,
    }) => {
      const memberUser = await makeUser({ email: "member@test.com" });
      await makeMember(memberUser.id, organizationId);

      const teamA = await makeTeam(organizationId, adminUser.id, {
        name: "Visible Team",
      });
      const _teamB = await makeTeam(organizationId, adminUser.id, {
        name: "Hidden Team",
      });

      await makeTeamMember(teamA.id, memberUser.id);

      // Swap the request user to the member
      const memberApp = createFastifyInstance();
      memberApp.addHook("onRequest", async (request) => {
        (
          request as typeof request & { user: unknown; organizationId: string }
        ).user = memberUser;
        (
          request as typeof request & {
            user: { id: string };
            organizationId: string;
          }
        ).organizationId = organizationId;
      });
      const { default: teamRoutes } = await import("./team");
      await memberApp.register(teamRoutes);

      // Member does NOT have team:admin permission
      hasPermissionMock.mockResolvedValue({ success: false });

      const response = await memberApp.inject({
        method: "GET",
        url: "/api/teams",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const names = body.data.map((t: { name: string }) => t.name);
      expect(names).toContain("Visible Team");
      expect(names).not.toContain("Hidden Team");

      await memberApp.close();
    });

    test("member cannot get a team they do not belong to", async ({
      makeTeam,
      makeUser,
      makeMember,
    }) => {
      const memberUser = await makeUser({ email: "outsider@test.com" });
      await makeMember(memberUser.id, organizationId);

      const team = await makeTeam(organizationId, adminUser.id, {
        name: "Private Team",
      });

      const memberApp = createFastifyInstance();
      memberApp.addHook("onRequest", async (request) => {
        (
          request as typeof request & { user: unknown; organizationId: string }
        ).user = memberUser;
        (
          request as typeof request & {
            user: { id: string };
            organizationId: string;
          }
        ).organizationId = organizationId;
      });
      const { default: teamRoutes } = await import("./team");
      await memberApp.register(teamRoutes);

      hasPermissionMock.mockResolvedValue({ success: false });

      const response = await memberApp.inject({
        method: "GET",
        url: `/api/teams/${team.id}`,
      });

      expect(response.statusCode).toBe(404);

      await memberApp.close();
    });

    test("admin can get any team in the organization", async ({ makeTeam }) => {
      const team = await makeTeam(organizationId, adminUser.id, {
        name: "Any Team",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/teams/${team.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().name).toBe("Any Team");
    });
  });

  // ===================================================================
  // Team CRUD
  // ===================================================================

  describe("team CRUD", () => {
    test("creates a team", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/teams",
        payload: { name: "New Team", description: "A brand new team" },
      });

      expect(response.statusCode).toBe(200);
      const team = response.json();
      expect(team.name).toBe("New Team");
      expect(team.description).toBe("A brand new team");
      expect(team.id).toBeDefined();
    });

    test("gets a team by id", async ({ makeTeam }) => {
      const team = await makeTeam(organizationId, adminUser.id, {
        name: "Lookup Team",
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/teams/${team.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().id).toBe(team.id);
      expect(response.json().name).toBe("Lookup Team");
    });

    test("updates a team", async ({ makeTeam }) => {
      const team = await makeTeam(organizationId, adminUser.id, {
        name: "Old Name",
      });

      const response = await app.inject({
        method: "PUT",
        url: `/api/teams/${team.id}`,
        payload: { name: "New Name", description: "Updated desc" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().name).toBe("New Name");
      expect(response.json().description).toBe("Updated desc");
    });

    test("deletes a team", async ({ makeTeam }) => {
      const team = await makeTeam(organizationId, adminUser.id, {
        name: "Doomed Team",
      });

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/teams/${team.id}`,
      });

      expect(deleteResponse.statusCode).toBe(200);
      expect(deleteResponse.json().success).toBe(true);

      // Verify deleted
      const getResponse = await app.inject({
        method: "GET",
        url: `/api/teams/${team.id}`,
      });
      expect(getResponse.statusCode).toBe(404);
    });

    test("lists all teams with pagination", async ({ makeTeam }) => {
      await makeTeam(organizationId, adminUser.id, { name: "Team Alpha" });
      await makeTeam(organizationId, adminUser.id, { name: "Team Beta" });

      const response = await app.inject({
        method: "GET",
        url: "/api/teams?limit=10&offset=0",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.length).toBeGreaterThanOrEqual(2);
      expect(body.pagination).toBeDefined();
      expect(body.pagination.total).toBeGreaterThanOrEqual(2);
    });

    test("returns 404 for non-existent team", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/teams/non-existent-id",
      });

      expect(response.statusCode).toBe(404);
    });

    test("returns 404 when updating non-existent team", async () => {
      const response = await app.inject({
        method: "PUT",
        url: "/api/teams/non-existent-id",
        payload: { name: "Ghost" },
      });

      expect(response.statusCode).toBe(404);
    });

    test("returns 404 when deleting non-existent team", async () => {
      const response = await app.inject({
        method: "DELETE",
        url: "/api/teams/non-existent-id",
      });

      expect(response.statusCode).toBe(404);
    });

    test("member who is team member can update their team", async ({
      makeTeam,
      makeUser,
      makeMember,
      makeTeamMember,
    }) => {
      const memberUser = await makeUser({ email: "team-member@test.com" });
      await makeMember(memberUser.id, organizationId);

      const team = await makeTeam(organizationId, adminUser.id, {
        name: "Editable",
      });
      await makeTeamMember(team.id, memberUser.id);

      const memberApp = createFastifyInstance();
      memberApp.addHook("onRequest", async (request) => {
        (
          request as typeof request & { user: unknown; organizationId: string }
        ).user = memberUser;
        (
          request as typeof request & {
            user: { id: string };
            organizationId: string;
          }
        ).organizationId = organizationId;
      });
      const { default: teamRoutes } = await import("./team");
      await memberApp.register(teamRoutes);

      hasPermissionMock.mockResolvedValue({ success: false });

      const response = await memberApp.inject({
        method: "PUT",
        url: `/api/teams/${team.id}`,
        payload: { name: "Edited By Member" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().name).toBe("Edited By Member");

      await memberApp.close();
    });

    test("member who is NOT team member cannot update a team", async ({
      makeTeam,
      makeUser,
      makeMember,
    }) => {
      const memberUser = await makeUser({ email: "non-member@test.com" });
      await makeMember(memberUser.id, organizationId);

      const team = await makeTeam(organizationId, adminUser.id, {
        name: "Locked",
      });

      const memberApp = createFastifyInstance();
      memberApp.addHook("onRequest", async (request) => {
        (
          request as typeof request & { user: unknown; organizationId: string }
        ).user = memberUser;
        (
          request as typeof request & {
            user: { id: string };
            organizationId: string;
          }
        ).organizationId = organizationId;
      });
      const { default: teamRoutes } = await import("./team");
      await memberApp.register(teamRoutes);

      hasPermissionMock.mockResolvedValue({ success: false });

      const response = await memberApp.inject({
        method: "PUT",
        url: `/api/teams/${team.id}`,
        payload: { name: "Hacked" },
      });

      expect(response.statusCode).toBe(403);

      await memberApp.close();
    });
  });

  // ===================================================================
  // Team Member Management
  // ===================================================================

  describe("team member management", () => {
    test("returns hydrated team members with user details", async ({
      makeTeam,
      makeUser,
    }) => {
      const team = await makeTeam(organizationId, adminUser.id);
      const member = await makeUser({
        name: "Hydrated Member",
        email: "hydrated@example.com",
      });

      const { TeamModel } = await import("@/models");
      await TeamModel.addMember(team.id, member.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/teams/${team.id}/members`,
      });
      const payload = response.json();

      expect(response.statusCode).toBe(200);
      expect(payload).toEqual([
        expect.objectContaining({
          userId: member.id,
          name: "Hydrated Member",
          email: "hydrated@example.com",
        }),
      ]);
    });

    test("adds a member to a team", async ({ makeTeam, makeUser }) => {
      const team = await makeTeam(organizationId, adminUser.id);
      const newMember = await makeUser({ email: "newmember@test.com" });

      const response = await app.inject({
        method: "POST",
        url: `/api/teams/${team.id}/members`,
        payload: { userId: newMember.id, role: "member" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().userId).toBe(newMember.id);
    });

    test("removes a member from a team", async ({
      makeTeam,
      makeUser,
      makeTeamMember,
    }) => {
      const team = await makeTeam(organizationId, adminUser.id);
      const member = await makeUser({ email: "removable@test.com" });
      await makeTeamMember(team.id, member.id);

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/teams/${team.id}/members/${member.id}`,
      });

      expect(deleteResponse.statusCode).toBe(200);
      expect(deleteResponse.json().success).toBe(true);

      // Verify member is gone
      const listResponse = await app.inject({
        method: "GET",
        url: `/api/teams/${team.id}/members`,
      });
      const members = listResponse.json();
      expect(
        members.some((m: { userId: string }) => m.userId === member.id),
      ).toBe(false);
    });

    test("returns 404 when listing members of non-existent team", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/teams/non-existent-id/members",
      });

      expect(response.statusCode).toBe(404);
    });

    test("returns 404 when removing non-existent member", async ({
      makeTeam,
    }) => {
      const team = await makeTeam(organizationId, adminUser.id);

      const response = await app.inject({
        method: "DELETE",
        url: `/api/teams/${team.id}/members/non-existent-user`,
      });

      expect(response.statusCode).toBe(404);
    });

    test("member cannot list members of a team they do not belong to", async ({
      makeTeam,
      makeUser,
      makeMember,
    }) => {
      const outsider = await makeUser({ email: "outsider-members@test.com" });
      await makeMember(outsider.id, organizationId);

      const team = await makeTeam(organizationId, adminUser.id);

      const memberApp = createFastifyInstance();
      memberApp.addHook("onRequest", async (request) => {
        (
          request as typeof request & { user: unknown; organizationId: string }
        ).user = outsider;
        (
          request as typeof request & {
            user: { id: string };
            organizationId: string;
          }
        ).organizationId = organizationId;
      });
      const { default: teamRoutes } = await import("./team");
      await memberApp.register(teamRoutes);

      hasPermissionMock.mockResolvedValue({ success: false });

      const response = await memberApp.inject({
        method: "GET",
        url: `/api/teams/${team.id}/members`,
      });

      expect(response.statusCode).toBe(404);

      await memberApp.close();
    });
  });

  // ===================================================================
  // External Group Mappings (Enterprise Feature)
  // ===================================================================

  describe("external group mappings", () => {
    test("lists external groups for a team", async ({ makeTeam }) => {
      const team = await makeTeam(organizationId, adminUser.id);

      const response = await app.inject({
        method: "GET",
        url: `/api/teams/${team.id}/external-groups`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([]);
    });

    test("adds an external group mapping", async ({ makeTeam }) => {
      const team = await makeTeam(organizationId, adminUser.id);

      const response = await app.inject({
        method: "POST",
        url: `/api/teams/${team.id}/external-groups`,
        payload: { groupIdentifier: "engineering" },
      });

      expect(response.statusCode).toBe(200);
      const group = response.json();
      expect(group.groupIdentifier).toBe("engineering");
      expect(group.id).toBeDefined();
    });

    test("removes an external group mapping", async ({ makeTeam }) => {
      const team = await makeTeam(organizationId, adminUser.id);

      // Add a group first
      const addResponse = await app.inject({
        method: "POST",
        url: `/api/teams/${team.id}/external-groups`,
        payload: { groupIdentifier: "devops" },
      });
      const group = addResponse.json();

      // Remove it
      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/teams/${team.id}/external-groups/${group.id}`,
      });

      expect(deleteResponse.statusCode).toBe(200);
      expect(deleteResponse.json().success).toBe(true);

      // Verify removal
      const listResponse = await app.inject({
        method: "GET",
        url: `/api/teams/${team.id}/external-groups`,
      });
      expect(listResponse.json()).toEqual([]);
    });

    test("prevents duplicate external group mappings", async ({ makeTeam }) => {
      const team = await makeTeam(organizationId, adminUser.id);

      await app.inject({
        method: "POST",
        url: `/api/teams/${team.id}/external-groups`,
        payload: { groupIdentifier: "qa-team" },
      });

      const duplicateResponse = await app.inject({
        method: "POST",
        url: `/api/teams/${team.id}/external-groups`,
        payload: { groupIdentifier: "qa-team" },
      });

      expect(duplicateResponse.statusCode).toBe(409);
      expect(duplicateResponse.json().error.message).toContain(
        "already mapped",
      );
    });

    test("normalizes group identifiers to lowercase", async ({ makeTeam }) => {
      const team = await makeTeam(organizationId, adminUser.id);

      const response = await app.inject({
        method: "POST",
        url: `/api/teams/${team.id}/external-groups`,
        payload: { groupIdentifier: "Engineering-Team" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().groupIdentifier).toBe("engineering-team");
    });

    test("returns 404 when removing non-existent group mapping", async ({
      makeTeam,
    }) => {
      const team = await makeTeam(organizationId, adminUser.id);

      const response = await app.inject({
        method: "DELETE",
        url: `/api/teams/${team.id}/external-groups/non-existent-id`,
      });

      expect(response.statusCode).toBe(404);
    });

    test("returns 404 for external groups of non-existent team", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/teams/non-existent-id/external-groups",
      });

      expect(response.statusCode).toBe(404);
    });
  });
});
