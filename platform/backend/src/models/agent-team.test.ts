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

  describe("getUserAccessibleAgentIds", () => {
    test("teamless agent is accessible to any user", async ({
      makeAgent,
      makeTeam,
      makeOrganization,
      makeUser,
      makeTeamMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id);
      await makeTeamMember(team.id, user.id);

      // Agent with no team assignments (teamless)
      const teamlessAgent = await makeAgent({ organizationId: org.id });

      // Agent assigned to a team the user is NOT in
      const otherTeam = await makeTeam(org.id, user.id);
      const teamedAgent = await makeAgent({ organizationId: org.id });
      await AgentTeamModel.assignTeamsToAgent(teamedAgent.id, [otherTeam.id]);

      const accessibleIds = await AgentTeamModel.getUserAccessibleAgentIds(
        user.id,
        false,
      );

      // Teamless agent should be accessible
      expect(accessibleIds).toContain(teamlessAgent.id);
      // Agent in a different team should NOT be accessible
      expect(accessibleIds).not.toContain(teamedAgent.id);
    });

    test("teamless agents are returned even when user has no teams", async ({
      makeAgent,
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const teamlessAgent = await makeAgent({ organizationId: org.id });

      const accessibleIds = await AgentTeamModel.getUserAccessibleAgentIds(
        user.id,
        false,
      );

      expect(accessibleIds).toContain(teamlessAgent.id);
    });
  });

  describe("userHasAgentAccess", () => {
    test("returns true for teamless agents", async ({
      makeAgent,
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const teamlessAgent = await makeAgent({ organizationId: org.id });

      const hasAccess = await AgentTeamModel.userHasAgentAccess(
        user.id,
        teamlessAgent.id,
        false,
      );

      expect(hasAccess).toBe(true);
    });

    test("returns false for team-scoped agent when user is not in that team", async ({
      makeAgent,
      makeTeam,
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id);
      const agent = await makeAgent({ organizationId: org.id });
      await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

      // User is NOT a member of the team
      const hasAccess = await AgentTeamModel.userHasAgentAccess(
        user.id,
        agent.id,
        false,
      );

      expect(hasAccess).toBe(false);
    });
  });

  describe("teamHasAgentAccess", () => {
    test("returns true for teamless agent with valid teamId", async ({
      makeAgent,
      makeTeam,
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id);
      const agent = await makeAgent({ organizationId: org.id });

      const hasAccess = await AgentTeamModel.teamHasAgentAccess(
        agent.id,
        team.id,
      );

      expect(hasAccess).toBe(true);
    });

    test("returns true for teamless agent with null teamId", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });

      const hasAccess = await AgentTeamModel.teamHasAgentAccess(agent.id, null);

      expect(hasAccess).toBe(true);
    });

    test("returns true for team-scoped agent with matching teamId", async ({
      makeAgent,
      makeTeam,
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id);
      const agent = await makeAgent({ organizationId: org.id });
      await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

      const hasAccess = await AgentTeamModel.teamHasAgentAccess(
        agent.id,
        team.id,
      );

      expect(hasAccess).toBe(true);
    });

    test("returns false for team-scoped agent with null teamId", async ({
      makeAgent,
      makeTeam,
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id);
      const agent = await makeAgent({ organizationId: org.id });
      await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

      const hasAccess = await AgentTeamModel.teamHasAgentAccess(agent.id, null);

      expect(hasAccess).toBe(false);
    });

    test("returns false for team-scoped agent with wrong teamId", async ({
      makeAgent,
      makeTeam,
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const assignedTeam = await makeTeam(org.id, user.id);
      const otherTeam = await makeTeam(org.id, user.id);
      const agent = await makeAgent({ organizationId: org.id });
      await AgentTeamModel.assignTeamsToAgent(agent.id, [assignedTeam.id]);

      const hasAccess = await AgentTeamModel.teamHasAgentAccess(
        agent.id,
        otherTeam.id,
      );

      expect(hasAccess).toBe(false);
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
