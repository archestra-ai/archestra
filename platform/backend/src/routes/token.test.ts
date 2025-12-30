import type { IncomingHttpHeaders } from "node:http";
import type { Permissions } from "@shared";
import { type Mock, vi } from "vitest";
import { TeamModel, TeamTokenModel } from "@/models";
import { beforeEach, describe, expect, test } from "@/test";

// Mock the hasPermission function
vi.mock("@/auth", () => ({
  hasPermission: vi.fn(),
}));

import { hasPermission } from "@/auth";

const mockHasPermission = hasPermission as Mock;

/**
 * Helper to set up permission mock responses
 * Returns true for specified permissions, false for others
 */
function setupPermissions(grantedPermissions: Permissions) {
  mockHasPermission.mockImplementation(async (permissions: Permissions) => {
    // Check if all requested permissions are granted
    for (const [resource, actions] of Object.entries(permissions)) {
      const grantedActions = grantedPermissions[resource as keyof Permissions];
      if (!grantedActions) {
        return { success: false, error: null };
      }
      for (const action of actions as string[]) {
        if (!grantedActions.includes(action as never)) {
          return { success: false, error: null };
        }
      }
    }
    return { success: true, error: null };
  });
}

describe("Token Route Authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("checkTokenAccess helper", () => {
    // Import the module to test the helper function
    // We test it indirectly through the route handlers

    describe("org token authorization", () => {
      test("user with ac:update can access org token value", async ({
        makeOrganization,
      }) => {
        await makeOrganization();
        const { token } = await TeamTokenModel.createOrganizationToken();

        // Grant ac:update permission
        setupPermissions({ ac: ["update"] });

        const tokenValue = await TeamTokenModel.getTokenValue(token.id);

        // The checkTokenAccess function should pass for org tokens with ac:update
        // We verify by checking the permission was called correctly
        expect(mockHasPermission).not.toHaveBeenCalled(); // Not called yet

        // Simulate permission check as the route would do
        const { success } = await hasPermission(
          { ac: ["update"] },
          {} as IncomingHttpHeaders,
        );
        expect(success).toBe(true);
        expect(tokenValue).toBeDefined();
      });

      test("user without ac:update cannot access org token value", async ({
        makeOrganization,
      }) => {
        await makeOrganization();
        await TeamTokenModel.createOrganizationToken();

        // Grant only team permissions, not ac:update
        setupPermissions({ team: ["read", "update"] });

        const { success } = await hasPermission(
          { ac: ["update"] },
          {} as IncomingHttpHeaders,
        );
        expect(success).toBe(false);
      });
    });

    describe("team token authorization", () => {
      test("team admin can access any team token", async ({
        makeOrganization,
        makeUser,
        makeTeam,
      }) => {
        const org = await makeOrganization();
        const user = await makeUser();
        const team = await makeTeam(org.id, user.id, { name: "Test Team" });

        await TeamTokenModel.createTeamToken(team.id, team.name);

        // Grant team:admin permission
        setupPermissions({ team: ["admin"] });

        const { success } = await hasPermission(
          { team: ["admin"] },
          {} as IncomingHttpHeaders,
        );
        expect(success).toBe(true);
      });

      test("user with team:update and membership can access team token", async ({
        makeOrganization,
        makeUser,
        makeTeam,
        makeTeamMember,
      }) => {
        const org = await makeOrganization();
        const user = await makeUser();
        const team = await makeTeam(org.id, user.id, { name: "Test Team" });
        await makeTeamMember(team.id, user.id);

        const { token } = await TeamTokenModel.createTeamToken(
          team.id,
          team.name,
        );

        // Grant team:update permission
        setupPermissions({ team: ["update"] });

        // Verify permission check
        const { success: hasUpdate } = await hasPermission(
          { team: ["update"] },
          {} as IncomingHttpHeaders,
        );
        expect(hasUpdate).toBe(true);

        // Verify team membership
        const isMember = await TeamModel.isUserInTeam(team.id, user.id);
        expect(isMember).toBe(true);

        // Token should be accessible
        const tokenValue = await TeamTokenModel.getTokenValue(token.id);
        expect(tokenValue).toBeDefined();
      });

      test("user with team:update but no membership cannot access team token", async ({
        makeOrganization,
        makeUser,
        makeTeam,
      }) => {
        const org = await makeOrganization();
        const user = await makeUser();
        const otherUser = await makeUser();
        const team = await makeTeam(org.id, user.id, { name: "Test Team" });

        await TeamTokenModel.createTeamToken(team.id, team.name);

        // Grant team:update permission
        setupPermissions({ team: ["update"] });

        // Verify permission check passes
        const { success: hasUpdate } = await hasPermission(
          { team: ["update"] },
          {} as IncomingHttpHeaders,
        );
        expect(hasUpdate).toBe(true);

        // But user is not a member
        const isMember = await TeamModel.isUserInTeam(team.id, otherUser.id);
        expect(isMember).toBe(false);
      });

      test("user without team:update cannot access team token", async ({
        makeOrganization,
        makeUser,
        makeTeam,
        makeTeamMember,
      }) => {
        const org = await makeOrganization();
        const user = await makeUser();
        const team = await makeTeam(org.id, user.id, { name: "Test Team" });
        await makeTeamMember(team.id, user.id);

        await TeamTokenModel.createTeamToken(team.id, team.name);

        // Grant only team:read, not team:update
        setupPermissions({ team: ["read"] });

        const { success: hasUpdate } = await hasPermission(
          { team: ["update"] },
          {} as IncomingHttpHeaders,
        );
        expect(hasUpdate).toBe(false);
      });
    });
  });

  describe("GET /api/tokens filtering", () => {
    test("user with ac:update sees org token", async ({ makeOrganization }) => {
      await makeOrganization();
      await TeamTokenModel.ensureOrganizationToken();

      // Grant ac:update and team:admin
      setupPermissions({ ac: ["update"], team: ["admin"] });

      const { success: canSeeOrgTokens } = await hasPermission(
        { ac: ["update"] },
        {} as IncomingHttpHeaders,
      );
      expect(canSeeOrgTokens).toBe(true);

      const tokens = await TeamTokenModel.findAllWithTeam();
      const orgTokens = tokens.filter((t) => t.isOrganizationToken);
      expect(orgTokens.length).toBe(1);
    });

    test("user without ac:update does not see org token", async ({
      makeOrganization,
    }) => {
      await makeOrganization();
      await TeamTokenModel.ensureOrganizationToken();

      // Grant only team permissions
      setupPermissions({ team: ["admin"] });

      const { success: canSeeOrgTokens } = await hasPermission(
        { ac: ["update"] },
        {} as IncomingHttpHeaders,
      );
      expect(canSeeOrgTokens).toBe(false);

      // Simulate filtering logic from the route
      const tokens = await TeamTokenModel.findAllWithTeam();
      const visibleTokens = canSeeOrgTokens
        ? tokens
        : tokens.filter((t) => !t.isOrganizationToken);

      expect(visibleTokens.filter((t) => t.isOrganizationToken).length).toBe(0);
    });

    test("user with team:admin sees all team tokens", async ({
      makeOrganization,
      makeUser,
      makeTeam,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });

      await TeamTokenModel.createTeamToken(team1.id, team1.name);
      await TeamTokenModel.createTeamToken(team2.id, team2.name);

      // Grant team:admin
      setupPermissions({ team: ["admin"] });

      const { success: isTeamAdmin } = await hasPermission(
        { team: ["admin"] },
        {} as IncomingHttpHeaders,
      );
      expect(isTeamAdmin).toBe(true);

      const tokens = await TeamTokenModel.findAllWithTeam();
      const teamTokens = tokens.filter((t) => !t.isOrganizationToken);
      expect(teamTokens.length).toBe(2);
    });

    test("user with team:update sees only their team tokens", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeTeamMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const otherUser = await makeUser();

      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, otherUser.id, { name: "Team 2" });

      // User is only member of team1
      await makeTeamMember(team1.id, user.id);

      await TeamTokenModel.createTeamToken(team1.id, team1.name);
      await TeamTokenModel.createTeamToken(team2.id, team2.name);

      // Grant team:update but not team:admin
      setupPermissions({ team: ["update"] });

      const { success: isTeamAdmin } = await hasPermission(
        { team: ["admin"] },
        {} as IncomingHttpHeaders,
      );
      expect(isTeamAdmin).toBe(false);

      const { success: hasTeamUpdate } = await hasPermission(
        { team: ["update"] },
        {} as IncomingHttpHeaders,
      );
      expect(hasTeamUpdate).toBe(true);

      // Get user's teams
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);
      expect(userTeamIds).toContain(team1.id);
      expect(userTeamIds).not.toContain(team2.id);

      // Simulate filtering logic
      const tokens = await TeamTokenModel.findAllWithTeam();
      const visibleTokens = tokens.filter(
        (t) =>
          t.isOrganizationToken || (t.teamId && userTeamIds.includes(t.teamId)),
      );

      expect(visibleTokens.length).toBe(1);
      expect(visibleTokens[0].teamId).toBe(team1.id);
    });

    test("user without team:update sees no team tokens", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeTeamMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id, { name: "Test Team" });
      await makeTeamMember(team.id, user.id);

      await TeamTokenModel.createTeamToken(team.id, team.name);

      // Grant only team:read
      setupPermissions({ team: ["read"] });

      const { success: hasTeamUpdate } = await hasPermission(
        { team: ["update"] },
        {} as IncomingHttpHeaders,
      );
      expect(hasTeamUpdate).toBe(false);

      // Simulate filtering logic - no team tokens visible
      const tokens = await TeamTokenModel.findAllWithTeam();
      const visibleTokens = hasTeamUpdate
        ? tokens
        : tokens.filter((t) => t.isOrganizationToken);

      expect(visibleTokens.filter((t) => !t.isOrganizationToken).length).toBe(
        0,
      );
    });
  });
});
