import { describe, expect, test } from "@/test";
import McpServerTeamModel from "./mcp-server-team";

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
});
