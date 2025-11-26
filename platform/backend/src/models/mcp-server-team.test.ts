import { describe, expect, test } from "@/test";
import McpServerTeamModel from "./mcp-server-team";
import TeamModel from "./team";

describe("McpServerTeamModel", () => {
  describe("getTeamDetailsForMcpServer", () => {
    test("returns team details for a single MCP server", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeMcpServer,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });
      const mcpServer = await makeMcpServer();

      await McpServerTeamModel.assignTeamsToMcpServer(mcpServer.id, [
        team1.id,
        team2.id,
      ]);

      const teamDetails = await McpServerTeamModel.getTeamDetailsForMcpServer(
        mcpServer.id,
      );

      expect(teamDetails).toHaveLength(2);
      expect(teamDetails.map((t) => t.teamId)).toContain(team1.id);
      expect(teamDetails.map((t) => t.teamId)).toContain(team2.id);
      expect(teamDetails.map((t) => t.name)).toContain("Team 1");
      expect(teamDetails.map((t) => t.name)).toContain("Team 2");
    });

    test("returns empty array when MCP server has no teams", async ({
      makeMcpServer,
    }) => {
      const mcpServer = await makeMcpServer();
      const teamDetails = await McpServerTeamModel.getTeamDetailsForMcpServer(
        mcpServer.id,
      );
      expect(teamDetails).toHaveLength(0);
    });
  });

  describe("getTeamDetailsForMcpServers", () => {
    test("returns team details for multiple MCP servers in bulk", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeMcpServer,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });
      const team3 = await makeTeam(org.id, user.id, { name: "Team 3" });

      const mcpServer1 = await makeMcpServer();
      const mcpServer2 = await makeMcpServer();
      const mcpServer3 = await makeMcpServer();

      await McpServerTeamModel.assignTeamsToMcpServer(mcpServer1.id, [
        team1.id,
        team2.id,
      ]);
      await McpServerTeamModel.assignTeamsToMcpServer(mcpServer2.id, [
        team3.id,
      ]);
      // mcpServer3 has no teams

      const teamDetailsMap =
        await McpServerTeamModel.getTeamDetailsForMcpServers([
          mcpServer1.id,
          mcpServer2.id,
          mcpServer3.id,
        ]);

      expect(teamDetailsMap.size).toBe(3);

      const server1Teams = teamDetailsMap.get(mcpServer1.id);
      expect(server1Teams).toHaveLength(2);
      expect(server1Teams?.map((t) => t.teamId)).toContain(team1.id);
      expect(server1Teams?.map((t) => t.teamId)).toContain(team2.id);
      expect(server1Teams?.map((t) => t.name)).toContain("Team 1");
      expect(server1Teams?.map((t) => t.name)).toContain("Team 2");

      const server2Teams = teamDetailsMap.get(mcpServer2.id);
      expect(server2Teams).toHaveLength(1);
      expect(server2Teams?.[0].teamId).toBe(team3.id);
      expect(server2Teams?.[0].name).toBe("Team 3");

      const server3Teams = teamDetailsMap.get(mcpServer3.id);
      expect(server3Teams).toHaveLength(0);
    });

    test("returns empty map for empty MCP server IDs array", async () => {
      const teamDetailsMap =
        await McpServerTeamModel.getTeamDetailsForMcpServers([]);
      expect(teamDetailsMap.size).toBe(0);
    });
  });

  describe("syncMcpServerTeams", () => {
    test("syncs team assignments for an MCP server", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeMcpServer,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team1 = await makeTeam(org.id, user.id);
      const team2 = await makeTeam(org.id, user.id);
      const mcpServer = await makeMcpServer();

      const assignedCount = await McpServerTeamModel.syncMcpServerTeams(
        mcpServer.id,
        [team1.id, team2.id],
      );

      expect(assignedCount).toBe(2);

      const teams = await McpServerTeamModel.getTeamsForMcpServer(mcpServer.id);
      expect(teams).toHaveLength(2);
      expect(teams).toContain(team1.id);
      expect(teams).toContain(team2.id);
    });

    test("replaces existing team assignments", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeMcpServer,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team1 = await makeTeam(org.id, user.id);
      const team2 = await makeTeam(org.id, user.id);
      const team3 = await makeTeam(org.id, user.id);
      const mcpServer = await makeMcpServer();

      await McpServerTeamModel.syncMcpServerTeams(mcpServer.id, [
        team1.id,
        team2.id,
      ]);
      await McpServerTeamModel.syncMcpServerTeams(mcpServer.id, [team3.id]);

      const teams = await McpServerTeamModel.getTeamsForMcpServer(mcpServer.id);
      expect(teams).toHaveLength(1);
      expect(teams).toContain(team3.id);
      expect(teams).not.toContain(team1.id);
      expect(teams).not.toContain(team2.id);
    });
  });

  describe("getUserAccessibleMcpServerIds", () => {
    test("returns all MCP servers for admin users", async ({
      makeMcpServer,
    }) => {
      const mcpServer1 = await makeMcpServer();
      const mcpServer2 = await makeMcpServer();
      const mcpServer3 = await makeMcpServer();

      const accessibleIds =
        await McpServerTeamModel.getUserAccessibleMcpServerIds(
          "any-user-id",
          true, // isMcpServerAdmin
        );

      expect(accessibleIds).toContain(mcpServer1.id);
      expect(accessibleIds).toContain(mcpServer2.id);
      expect(accessibleIds).toContain(mcpServer3.id);
    });

    test("returns MCP servers accessible through team membership", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeMcpServer,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });

      // Add user to teams
      await TeamModel.addMember(team1.id, user.id);
      await TeamModel.addMember(team2.id, user.id);

      const mcpServer1 = await makeMcpServer();
      const mcpServer2 = await makeMcpServer();
      const mcpServer3 = await makeMcpServer(); // Not assigned to any team

      // Assign MCP servers to teams
      await McpServerTeamModel.assignTeamsToMcpServer(mcpServer1.id, [
        team1.id,
      ]);
      await McpServerTeamModel.assignTeamsToMcpServer(mcpServer2.id, [
        team2.id,
      ]);

      const accessibleIds =
        await McpServerTeamModel.getUserAccessibleMcpServerIds(
          user.id,
          false, // not admin
        );

      expect(accessibleIds).toContain(mcpServer1.id);
      expect(accessibleIds).toContain(mcpServer2.id);
      expect(accessibleIds).not.toContain(mcpServer3.id);
    });

    test("removes duplicates when user is in multiple teams with same MCP server", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeMcpServer,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });

      // Add user to both teams
      await TeamModel.addMember(team1.id, user.id);
      await TeamModel.addMember(team2.id, user.id);

      const mcpServer = await makeMcpServer();

      // Assign same MCP server to both teams
      await McpServerTeamModel.assignTeamsToMcpServer(mcpServer.id, [
        team1.id,
        team2.id,
      ]);

      const accessibleIds =
        await McpServerTeamModel.getUserAccessibleMcpServerIds(
          user.id,
          false, // not admin
        );

      // Should only appear once despite being in two teams
      expect(accessibleIds).toHaveLength(1);
      expect(accessibleIds[0]).toBe(mcpServer.id);
    });

    test("returns empty array when user is not in any teams", async ({
      makeUser,
      makeMcpServer,
    }) => {
      const user = await makeUser();
      await makeMcpServer(); // MCP server exists but user has no access

      const accessibleIds =
        await McpServerTeamModel.getUserAccessibleMcpServerIds(
          user.id,
          false, // not admin
        );

      expect(accessibleIds).toHaveLength(0);
    });
  });

  describe("userHasMcpServerAccess", () => {
    test("returns true for admin users", async ({ makeMcpServer }) => {
      const mcpServer = await makeMcpServer();

      const hasAccess = await McpServerTeamModel.userHasMcpServerAccess(
        "any-user-id",
        mcpServer.id,
        true, // isMcpServerAdmin
      );

      expect(hasAccess).toBe(true);
    });

    test("returns true when user has access through team membership", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeMcpServer,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id, { name: "Team 1" });

      // Add user to team
      await TeamModel.addMember(team.id, user.id);

      const mcpServer = await makeMcpServer();

      // Assign MCP server to team
      await McpServerTeamModel.assignTeamsToMcpServer(mcpServer.id, [team.id]);

      const hasAccess = await McpServerTeamModel.userHasMcpServerAccess(
        user.id,
        mcpServer.id,
        false, // not admin
      );

      expect(hasAccess).toBe(true);
    });

    test("returns false when user does not have access", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeMcpServer,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const otherUser = await makeUser();
      const team = await makeTeam(org.id, otherUser.id, { name: "Team 1" });

      // Add other user to team (not the test user)
      await TeamModel.addMember(team.id, otherUser.id);

      const mcpServer = await makeMcpServer();

      // Assign MCP server to team
      await McpServerTeamModel.assignTeamsToMcpServer(mcpServer.id, [team.id]);

      const hasAccess = await McpServerTeamModel.userHasMcpServerAccess(
        user.id, // Different user
        mcpServer.id,
        false, // not admin
      );

      expect(hasAccess).toBe(false);
    });

    test("returns false when MCP server is not assigned to any teams", async ({
      makeUser,
      makeMcpServer,
    }) => {
      const user = await makeUser();
      const mcpServer = await makeMcpServer();

      const hasAccess = await McpServerTeamModel.userHasMcpServerAccess(
        user.id,
        mcpServer.id,
        false, // not admin
      );

      expect(hasAccess).toBe(false);
    });
  });

  describe("getTeamsForMcpServer", () => {
    test("returns team IDs assigned to an MCP server", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeMcpServer,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });
      const mcpServer = await makeMcpServer();

      await McpServerTeamModel.assignTeamsToMcpServer(mcpServer.id, [
        team1.id,
        team2.id,
      ]);

      const teams = await McpServerTeamModel.getTeamsForMcpServer(mcpServer.id);

      expect(teams).toHaveLength(2);
      expect(teams).toContain(team1.id);
      expect(teams).toContain(team2.id);
    });

    test("returns empty array when MCP server has no teams", async ({
      makeMcpServer,
    }) => {
      const mcpServer = await makeMcpServer();

      const teams = await McpServerTeamModel.getTeamsForMcpServer(mcpServer.id);

      expect(teams).toHaveLength(0);
    });
  });

  describe("assignTeamsToMcpServer", () => {
    test("assigns teams to an MCP server", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeMcpServer,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team1 = await makeTeam(org.id, user.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, user.id, { name: "Team 2" });
      const mcpServer = await makeMcpServer();

      await McpServerTeamModel.assignTeamsToMcpServer(mcpServer.id, [
        team1.id,
        team2.id,
      ]);

      const teams = await McpServerTeamModel.getTeamsForMcpServer(mcpServer.id);
      expect(teams).toHaveLength(2);
      expect(teams).toContain(team1.id);
      expect(teams).toContain(team2.id);
    });

    test("is idempotent - can assign same team multiple times", async ({
      makeOrganization,
      makeUser,
      makeTeam,
      makeMcpServer,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id, { name: "Team 1" });
      const mcpServer = await makeMcpServer();

      // Assign same team twice
      await McpServerTeamModel.assignTeamsToMcpServer(mcpServer.id, [team.id]);
      await McpServerTeamModel.assignTeamsToMcpServer(mcpServer.id, [team.id]);

      const teams = await McpServerTeamModel.getTeamsForMcpServer(mcpServer.id);
      // Should still only have one team (idempotent)
      expect(teams).toHaveLength(1);
      expect(teams).toContain(team.id);
    });

    test("handles empty team IDs array", async ({ makeMcpServer }) => {
      const mcpServer = await makeMcpServer();

      // Should not throw
      await McpServerTeamModel.assignTeamsToMcpServer(mcpServer.id, []);

      const teams = await McpServerTeamModel.getTeamsForMcpServer(mcpServer.id);
      expect(teams).toHaveLength(0);
    });
  });
});
