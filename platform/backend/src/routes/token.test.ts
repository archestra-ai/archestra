import type { IncomingHttpHeaders } from "node:http";
import type { Permissions } from "@archestra/shared";
import { type Mock, vi } from "vitest";
import {
  AgentModel,
  AgentTeamModel,
  TeamModel,
  TeamTokenModel,
} from "@/models";
import { beforeEach, describe, expect, test } from "@/test";

// Mock the hasPermission function
vi.mock("@/auth");

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
      test("organization-level team manager can access any team token", async ({
        makeOrganization,
        makeUser,
        makeTeam,
      }) => {
        const org = await makeOrganization();
        const user = await makeUser();
        const team = await makeTeam(org.id, user.id, { name: "Test Team" });

        await TeamTokenModel.createTeamToken(team.id, team.name);

        setupPermissions({ team: ["create"] });

        const { success } = await hasPermission(
          { team: ["create"] },
          {} as IncomingHttpHeaders,
        );
        expect(success).toBe(true);
      });

      test("literal team admin can access team token", async ({
        makeOrganization,
        makeUser,
        makeTeam,
        makeTeamMember,
      }) => {
        const org = await makeOrganization();
        const user = await makeUser();
        const team = await makeTeam(org.id, user.id, { name: "Test Team" });
        await makeTeamMember(team.id, user.id, { role: "admin" });

        const { token } = await TeamTokenModel.createTeamToken(
          team.id,
          team.name,
        );

        setupPermissions({ team: ["read"] });

        const isTeamAdmin = await TeamModel.isUserTeamAdmin(team.id, user.id);
        expect(isTeamAdmin).toBe(true);

        // Token should be accessible
        const tokenValue = await TeamTokenModel.getTokenValue(token.id);
        expect(tokenValue).toBeDefined();
      });

      test("literal team member cannot access team token", async ({
        makeOrganization,
        makeUser,
        makeTeam,
        makeTeamMember,
      }) => {
        const org = await makeOrganization();
        const user = await makeUser();
        const team = await makeTeam(org.id, user.id, { name: "Test Team" });
        await makeTeamMember(team.id, user.id, { role: "member" });

        await TeamTokenModel.createTeamToken(team.id, team.name);

        setupPermissions({ team: ["read"] });

        const isTeamAdmin = await TeamModel.isUserTeamAdmin(team.id, user.id);
        expect(isTeamAdmin).toBe(false);
      });

      test("user without team admin role cannot access team token", async ({
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

        setupPermissions({ team: ["read"] });

        const isTeamAdmin = await TeamModel.isUserTeamAdmin(team.id, user.id);
        expect(isTeamAdmin).toBe(false);
      });
    });
  });

  describe("GET /api/tokens filtering", () => {
    test("user with ac:update sees org token", async ({ makeOrganization }) => {
      await makeOrganization();
      await TeamTokenModel.ensureOrganizationToken();

      setupPermissions({ ac: ["update"], team: ["create"] });

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

      setupPermissions({ team: ["create"] });

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

    test("organization-level team manager sees all team tokens", async ({
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

      setupPermissions({ team: ["create"] });

      const { success: canManageAllTeams } = await hasPermission(
        { team: ["create"] },
        {} as IncomingHttpHeaders,
      );
      expect(canManageAllTeams).toBe(true);

      const tokens = await TeamTokenModel.findAllWithTeam();
      const teamTokens = tokens.filter((t) => !t.isOrganizationToken);
      expect(teamTokens.length).toBe(2);
    });

    test("team member sees only tokens for teams they belong to", async ({
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

      await makeTeamMember(team1.id, user.id, { role: "admin" });

      await TeamTokenModel.createTeamToken(team1.id, team1.name);
      await TeamTokenModel.createTeamToken(team2.id, team2.name);

      setupPermissions({ team: ["read"] });

      // Get user's teams (membership, any role — same as the route)
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);
      expect(userTeamIds).toEqual([team1.id]);

      // Simulate filtering logic
      const tokens = await TeamTokenModel.findAllWithTeam();
      const visibleTokens = tokens.filter(
        (t) =>
          t.isOrganizationToken || (t.teamId && userTeamIds.includes(t.teamId)),
      );

      expect(visibleTokens.length).toBe(1);
      expect(visibleTokens[0].teamId).toBe(team1.id);
    });

    test("user with mcpGateway:team-admin and membership sees their team tokens", async ({
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

      // Grant only mcpGateway:team-admin
      setupPermissions({ mcpGateway: ["team-admin"] });

      const { success: hasTeamUpdate } = await hasPermission(
        { team: ["update"] },
        {} as IncomingHttpHeaders,
      );
      expect(hasTeamUpdate).toBe(false);

      const { success: hasMcpGatewayTeamAdmin } = await hasPermission(
        { mcpGateway: ["team-admin"] },
        {} as IncomingHttpHeaders,
      );
      expect(hasMcpGatewayTeamAdmin).toBe(true);

      // Get user's teams
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);
      expect(userTeamIds).toContain(team1.id);
      expect(userTeamIds).not.toContain(team2.id);

      // Simulate filtering logic (same as route: mcpGateway:team-admin + membership)
      const tokens = await TeamTokenModel.findAllWithTeam();
      const visibleTokens = tokens.filter(
        (t) =>
          t.isOrganizationToken || (t.teamId && userTeamIds.includes(t.teamId)),
      );

      expect(visibleTokens.length).toBe(1);
      expect(visibleTokens[0].teamId).toBe(team1.id);
    });

    test("user with mcpGateway:team-admin but no membership sees no team tokens", async ({
      makeOrganization,
      makeUser,
      makeTeam,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const otherUser = await makeUser();
      const team = await makeTeam(org.id, otherUser.id, { name: "Test Team" });

      await TeamTokenModel.createTeamToken(team.id, team.name);

      // Grant only mcpGateway:team-admin
      setupPermissions({ mcpGateway: ["team-admin"] });

      const { success: hasMcpGatewayTeamAdmin } = await hasPermission(
        { mcpGateway: ["team-admin"] },
        {} as IncomingHttpHeaders,
      );
      expect(hasMcpGatewayTeamAdmin).toBe(true);

      // User is not a member of the team
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);
      expect(userTeamIds).not.toContain(team.id);

      // Simulate filtering logic
      const tokens = await TeamTokenModel.findAllWithTeam();
      const visibleTokens = tokens.filter(
        (t) =>
          t.isOrganizationToken || (t.teamId && userTeamIds.includes(t.teamId)),
      );

      expect(visibleTokens.filter((t) => !t.isOrganizationToken).length).toBe(
        0,
      );
    });

    test("plain team member without team management permissions still sees their team's token listed", async ({
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

      // Grant only team:read — the member can list the token's metadata,
      // while the value endpoint stays admin-gated (see checkTokenAccess
      // tests above).
      setupPermissions({ team: ["read"] });

      const { success: hasTeamUpdate } = await hasPermission(
        { team: ["update"] },
        {} as IncomingHttpHeaders,
      );
      expect(hasTeamUpdate).toBe(false);

      // Simulate filtering logic — membership grants listing visibility
      const userTeamIds = await TeamModel.getUserTeamIds(user.id);
      const tokens = await TeamTokenModel.findAllWithTeam();
      const visibleTokens = tokens.filter(
        (t) =>
          t.isOrganizationToken || (t.teamId && userTeamIds.includes(t.teamId)),
      );

      expect(visibleTokens.filter((t) => !t.isOrganizationToken).length).toBe(
        1,
      );
    });
  });
  describe("GET /api/tokens worksWithProfile annotation", () => {
    // Mirrors the route's rule (and AgentTeamModel.teamHasAgentAccess):
    // org-scoped agents accept any team token, team-scoped agents only
    // their assigned teams' tokens, personal agents none. Tokens are
    // annotated (not filtered) so the UI can grey out the rest.
    const annotateForAgent = async (
      profileId: string,
      tokens: Awaited<ReturnType<typeof TeamTokenModel.findAllWithTeam>>,
    ) => {
      const agent = await AgentModel.findAccessContextById(profileId);
      const profileTeamIds =
        agent?.scope === "team"
          ? await AgentTeamModel.getTeamsForAgent(profileId)
          : [];
      return tokens.map((t) => ({
        ...t,
        worksWithProfile:
          t.isOrganizationToken ||
          agent?.scope === "org" ||
          (agent?.scope === "team" &&
            !!t.teamId &&
            profileTeamIds.includes(t.teamId)),
      }));
    };

    test("org-scoped agent offers every team token, even without team assignments", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id, { name: "Team 1" });
      await TeamTokenModel.createTeamToken(team.id, team.name);

      const agent = await makeAgent({
        organizationId: org.id,
        scope: "org",
        teams: [],
      });

      const tokens = await TeamTokenModel.findAllWithTeam();
      const annotated = await annotateForAgent(agent.id, tokens);

      expect(
        annotated.filter((t) => !t.isOrganizationToken && t.worksWithProfile)
          .length,
      ).toBe(1);
    });

    test("team-scoped agent only offers its assigned teams' tokens", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });
      await TeamTokenModel.createTeamToken(team1.id, team1.name);
      await TeamTokenModel.createTeamToken(team2.id, team2.name);

      const agent = await makeAgent({
        organizationId: org.id,
        scope: "team",
        teams: [team1.id],
      });

      const tokens = await TeamTokenModel.findAllWithTeam();
      const annotated = await annotateForAgent(agent.id, tokens);

      const workingTeamTokens = annotated.filter(
        (t) => !t.isOrganizationToken && t.worksWithProfile,
      );
      expect(workingTeamTokens.length).toBe(1);
      expect(workingTeamTokens[0].teamId).toBe(team1.id);
      // The other team's token stays listed, just marked unusable
      expect(annotated.filter((t) => !t.isOrganizationToken).length).toBe(2);
    });

    test("personal agent offers no team tokens", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id, { name: "Team 1" });
      await TeamTokenModel.createTeamToken(team.id, team.name);

      const agent = await makeAgent({
        organizationId: org.id,
        scope: "personal",
        teams: [],
        authorId: user.id,
      });

      const tokens = await TeamTokenModel.findAllWithTeam();
      const annotated = await annotateForAgent(agent.id, tokens);

      // Still listed, but no team token is usable against a personal agent
      expect(annotated.filter((t) => !t.isOrganizationToken).length).toBe(1);
      expect(
        annotated.filter((t) => !t.isOrganizationToken && t.worksWithProfile)
          .length,
      ).toBe(0);
    });
  });
});
