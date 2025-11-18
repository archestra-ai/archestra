import { describe, expect, test } from "@/test";
import AgentTeamModel from "./agent-team";

describe("AgentTeamModel", () => {
  describe("getTeamsForAgent", () => {
    test("returns team IDs for a single agent", async ({
      makeAgent,
      makeTeam,
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team1 = await makeTeam(org.id, user.id);
      const team2 = await makeTeam(org.id, user.id);
      const agent = await makeAgent();

      await AgentTeamModel.assignTeamsToAgent(agent.id, [team1.id, team2.id]);

      const teams = await AgentTeamModel.getTeamsForAgent(agent.id);

      expect(teams).toHaveLength(2);
      expect(teams).toContain(team1.id);
      expect(teams).toContain(team2.id);
    });

    test("returns empty array when agent has no teams", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();
      const teams = await AgentTeamModel.getTeamsForAgent(agent.id);
      expect(teams).toHaveLength(0);
    });
  });

  describe("getTeamsForAgents", () => {
    test("returns teams for multiple agents in bulk", async ({
      makeAgent,
      makeTeam,
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team1 = await makeTeam(org.id, user.id);
      const team2 = await makeTeam(org.id, user.id);
      const team3 = await makeTeam(org.id, user.id);

      const agent1 = await makeAgent();
      const agent2 = await makeAgent();
      const agent3 = await makeAgent();

      await AgentTeamModel.assignTeamsToAgent(agent1.id, [team1.id, team2.id]);
      await AgentTeamModel.assignTeamsToAgent(agent2.id, [team3.id]);
      // agent3 has no teams

      const teamsMap = await AgentTeamModel.getTeamsForAgents([
        agent1.id,
        agent2.id,
        agent3.id,
      ]);

      expect(teamsMap.size).toBe(3);

      const agent1Teams = teamsMap.get(agent1.id);
      expect(agent1Teams).toHaveLength(2);
      expect(agent1Teams).toContain(team1.id);
      expect(agent1Teams).toContain(team2.id);

      const agent2Teams = teamsMap.get(agent2.id);
      expect(agent2Teams).toHaveLength(1);
      expect(agent2Teams).toContain(team3.id);

      const agent3Teams = teamsMap.get(agent3.id);
      expect(agent3Teams).toHaveLength(0);
    });

    test("returns empty map for empty agent IDs array", async () => {
      const teamsMap = await AgentTeamModel.getTeamsForAgents([]);
      expect(teamsMap.size).toBe(0);
    });
  });

  describe("syncAgentTeams", () => {
    test("syncs team assignments for an agent", async ({
      makeAgent,
      makeTeam,
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team1 = await makeTeam(org.id, user.id);
      const team2 = await makeTeam(org.id, user.id);
      const agent = await makeAgent();

      const assignedCount = await AgentTeamModel.syncAgentTeams(agent.id, [
        team1.id,
        team2.id,
      ]);

      expect(assignedCount).toBe(2);

      const teams = await AgentTeamModel.getTeamsForAgent(agent.id);
      expect(teams).toHaveLength(2);
      expect(teams).toContain(team1.id);
      expect(teams).toContain(team2.id);
    });

    test("replaces existing team assignments", async ({
      makeAgent,
      makeTeam,
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team1 = await makeTeam(org.id, user.id);
      const team2 = await makeTeam(org.id, user.id);
      const team3 = await makeTeam(org.id, user.id);
      const agent = await makeAgent();

      await AgentTeamModel.syncAgentTeams(agent.id, [team1.id, team2.id]);
      await AgentTeamModel.syncAgentTeams(agent.id, [team3.id]);

      const teams = await AgentTeamModel.getTeamsForAgent(agent.id);
      expect(teams).toHaveLength(1);
      expect(teams).toContain(team3.id);
      expect(teams).not.toContain(team1.id);
      expect(teams).not.toContain(team2.id);
    });

    test("clears all team assignments when syncing with empty array", async ({
      makeAgent,
      makeTeam,
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team1 = await makeTeam(org.id, user.id);
      const agent = await makeAgent();

      await AgentTeamModel.syncAgentTeams(agent.id, [team1.id]);
      await AgentTeamModel.syncAgentTeams(agent.id, []);

      const teams = await AgentTeamModel.getTeamsForAgent(agent.id);
      expect(teams).toHaveLength(0);
    });
  });
});
