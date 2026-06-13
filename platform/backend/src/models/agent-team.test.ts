import { describe, expect, test } from "@/test";
import AgentTeamModel from "./agent-team";
import TeamLabelModel from "./team-label";

describe("AgentTeamModel", () => {
  describe("getTeamLabelInfoForAgent", () => {
    test("returns each team's id, name and labels", async ({
      makeAgent,
      makeTeam,
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team1 = await makeTeam(org.id, user.id, { name: "Platform" });
      const team2 = await makeTeam(org.id, user.id, { name: "Security" });
      const agent = await makeAgent();

      await AgentTeamModel.assignTeamsToAgent(agent.id, [team1.id, team2.id]);
      await TeamLabelModel.syncTeamLabels(team1.id, [
        { key: "env", value: "prod", keyId: "", valueId: "" },
      ]);

      const info = await AgentTeamModel.getTeamLabelInfoForAgent(agent.id);

      expect(info).toHaveLength(2);
      const platform = info.find((t) => t.id === team1.id);
      const security = info.find((t) => t.id === team2.id);
      expect(platform?.name).toBe("Platform");
      expect(platform?.labels).toEqual([
        expect.objectContaining({ key: "env", value: "prod" }),
      ]);
      expect(security?.labels).toEqual([]);
    });

    test("returns empty array when agent has no teams", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();
      const info = await AgentTeamModel.getTeamLabelInfoForAgent(agent.id);
      expect(info).toEqual([]);
    });
  });

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
    test("org-scoped agent is accessible to any user", async ({
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

      // Org-scoped agent (visible to all)
      const orgAgent = await makeAgent({
        organizationId: org.id,
        scope: "org",
      });

      // Team-scoped agent assigned to a team the user is NOT in
      const otherTeam = await makeTeam(org.id, user.id);
      const teamedAgent = await makeAgent({
        organizationId: org.id,
        scope: "team",
      });
      await AgentTeamModel.assignTeamsToAgent(teamedAgent.id, [otherTeam.id]);

      const accessibleIds = await AgentTeamModel.getUserAccessibleAgentIds(
        user.id,
        false,
      );

      // Org-scoped agent should be accessible
      expect(accessibleIds).toContain(orgAgent.id);
      // Team-scoped agent in a different team should NOT be accessible
      expect(accessibleIds).not.toContain(teamedAgent.id);
    });

    test("org-scoped agents are returned even when user has no teams", async ({
      makeAgent,
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const orgAgent = await makeAgent({
        organizationId: org.id,
        scope: "org",
      });

      const accessibleIds = await AgentTeamModel.getUserAccessibleAgentIds(
        user.id,
        false,
      );

      expect(accessibleIds).toContain(orgAgent.id);
    });

    test("team-scoped agent is accessible when user is a member of one of its teams but not another", async ({
      makeAgent,
      makeTeam,
      makeOrganization,
      makeUser,
      makeTeamMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const memberTeam = await makeTeam(org.id, user.id);
      const otherTeam = await makeTeam(org.id, user.id);
      await makeTeamMember(memberTeam.id, user.id);

      const visibleAgent = await makeAgent({
        organizationId: org.id,
        scope: "team",
      });
      await AgentTeamModel.assignTeamsToAgent(visibleAgent.id, [memberTeam.id]);

      const hiddenAgent = await makeAgent({
        organizationId: org.id,
        scope: "team",
      });
      await AgentTeamModel.assignTeamsToAgent(hiddenAgent.id, [otherTeam.id]);

      const accessibleIds = await AgentTeamModel.getUserAccessibleAgentIds(
        user.id,
        false,
      );

      expect(accessibleIds).toContain(visibleAgent.id);
      expect(accessibleIds).not.toContain(hiddenAgent.id);
    });

    test("personal-scoped agent is accessible only to its author", async ({
      makeAgent,
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const author = await makeUser();
      const otherUser = await makeUser();

      const ownAgent = await makeAgent({
        organizationId: org.id,
        scope: "personal",
        authorId: author.id,
      });
      const otherUsersAgent = await makeAgent({
        organizationId: org.id,
        scope: "personal",
        authorId: otherUser.id,
      });

      const authorAccessibleIds =
        await AgentTeamModel.getUserAccessibleAgentIds(author.id, false);
      expect(authorAccessibleIds).toContain(ownAgent.id);
      expect(authorAccessibleIds).not.toContain(otherUsersAgent.id);

      const otherAccessibleIds = await AgentTeamModel.getUserAccessibleAgentIds(
        otherUser.id,
        false,
      );
      expect(otherAccessibleIds).toContain(otherUsersAgent.id);
      expect(otherAccessibleIds).not.toContain(ownAgent.id);
    });
  });

  describe("userHasAgentAccess", () => {
    test("returns true for org-scoped agents", async ({
      makeAgent,
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();

      const orgAgent = await makeAgent({
        organizationId: org.id,
        scope: "org",
      });

      const hasAccess = await AgentTeamModel.userHasAgentAccess(
        user.id,
        orgAgent.id,
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
      const agent = await makeAgent({
        organizationId: org.id,
        scope: "team",
      });
      await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

      // User is NOT a member of the team
      const hasAccess = await AgentTeamModel.userHasAgentAccess(
        user.id,
        agent.id,
        false,
      );

      expect(hasAccess).toBe(false);
    });

    test("uses provided access context for personal agents", async ({
      makeUser,
    }) => {
      const author = await makeUser();
      const otherUser = await makeUser();

      const authorHasAccess = await AgentTeamModel.userHasAgentAccess(
        author.id,
        crypto.randomUUID(),
        false,
        {
          id: crypto.randomUUID(),
          organizationId: crypto.randomUUID(),
          scope: "personal",
          authorId: author.id,
        },
      );
      const otherUserHasAccess = await AgentTeamModel.userHasAgentAccess(
        otherUser.id,
        crypto.randomUUID(),
        false,
        {
          id: crypto.randomUUID(),
          organizationId: crypto.randomUUID(),
          scope: "personal",
          authorId: author.id,
        },
      );

      expect(authorHasAccess).toBe(true);
      expect(otherUserHasAccess).toBe(false);
    });

    test("uses provided access context for org-scoped agents without loading the agent", async ({
      makeUser,
    }) => {
      const user = await makeUser();

      const hasAccess = await AgentTeamModel.userHasAgentAccess(
        user.id,
        crypto.randomUUID(),
        false,
        {
          id: crypto.randomUUID(),
          organizationId: crypto.randomUUID(),
          scope: "org",
          authorId: null,
        },
      );

      expect(hasAccess).toBe(true);
    });
  });

  describe("teamHasAgentAccess", () => {
    test("returns true for org-scoped agent with valid teamId", async ({
      makeAgent,
      makeTeam,
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id);
      const agent = await makeAgent({
        organizationId: org.id,
        scope: "org",
      });

      const hasAccess = await AgentTeamModel.teamHasAgentAccess(
        agent.id,
        team.id,
      );

      expect(hasAccess).toBe(true);
    });

    test("returns true for org-scoped agent with null teamId", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({
        organizationId: org.id,
        scope: "org",
      });

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
      const agent = await makeAgent({
        organizationId: org.id,
        scope: "team",
      });
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
      const agent = await makeAgent({
        organizationId: org.id,
        scope: "team",
      });
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
      const agent = await makeAgent({
        organizationId: org.id,
        scope: "team",
      });
      await AgentTeamModel.assignTeamsToAgent(agent.id, [assignedTeam.id]);

      const hasAccess = await AgentTeamModel.teamHasAgentAccess(
        agent.id,
        otherTeam.id,
      );

      expect(hasAccess).toBe(false);
    });

    test("uses provided access context for org-scoped agents", async ({
      makeTeam,
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id);

      const hasAccess = await AgentTeamModel.teamHasAgentAccess(
        crypto.randomUUID(),
        team.id,
        {
          id: crypto.randomUUID(),
          organizationId: org.id,
          scope: "org",
          authorId: null,
        },
      );

      expect(hasAccess).toBe(true);
    });

    test("uses provided access context for team-scoped agents", async ({
      makeAgent,
      makeTeam,
      makeOrganization,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id);
      const agent = await makeAgent({
        organizationId: org.id,
        scope: "team",
      });
      await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

      const hasAccess = await AgentTeamModel.teamHasAgentAccess(
        agent.id,
        team.id,
        {
          id: agent.id,
          organizationId: org.id,
          scope: "team",
          authorId: agent.authorId,
        },
      );

      expect(hasAccess).toBe(true);
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
