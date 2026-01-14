import {
  TOOL_ARTIFACT_WRITE_FULL_NAME,
  TOOL_TODO_WRITE_FULL_NAME,
} from "@shared";
import { describe, expect, test } from "@/test";
import AgentModel from "./agent";
import TeamModel from "./team";

describe("AgentModel", () => {
  test("can create an agent", async () => {
    await AgentModel.create({ name: "Test Agent", teams: [] });
    await AgentModel.create({ name: "Test Agent 2", teams: [] });

    // Expecting 3: 2 created + 1 default agent from migration
    expect(await AgentModel.findAll()).toHaveLength(3);
  });

  describe("exists", () => {
    test("returns true for an existing agent", async () => {
      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [],
      });

      const exists = await AgentModel.exists(agent.id);
      expect(exists).toBe(true);
    });

    test("returns false for a non-existent agent", async () => {
      const nonExistentId = "00000000-0000-0000-0000-000000000000";
      const exists = await AgentModel.exists(nonExistentId);
      expect(exists).toBe(false);
    });
  });

  describe("existsBatch", () => {
    test("returns Set of existing agent IDs", async () => {
      const agent1 = await AgentModel.create({
        name: "Test Agent 1",
        teams: [],
      });
      const agent2 = await AgentModel.create({
        name: "Test Agent 2",
        teams: [],
      });
      const nonExistentId = "00000000-0000-0000-0000-000000000000";

      const existingIds = await AgentModel.existsBatch([
        agent1.id,
        agent2.id,
        nonExistentId,
      ]);

      expect(existingIds).toBeInstanceOf(Set);
      expect(existingIds.size).toBe(2);
      expect(existingIds.has(agent1.id)).toBe(true);
      expect(existingIds.has(agent2.id)).toBe(true);
      expect(existingIds.has(nonExistentId)).toBe(false);
    });

    test("returns empty Set for empty input", async () => {
      const existingIds = await AgentModel.existsBatch([]);

      expect(existingIds).toBeInstanceOf(Set);
      expect(existingIds.size).toBe(0);
    });

    test("returns empty Set when no agents exist", async () => {
      const nonExistentId1 = "00000000-0000-0000-0000-000000000000";
      const nonExistentId2 = "00000000-0000-4000-8000-000000000099";

      const existingIds = await AgentModel.existsBatch([
        nonExistentId1,
        nonExistentId2,
      ]);

      expect(existingIds).toBeInstanceOf(Set);
      expect(existingIds.size).toBe(0);
    });

    test("handles duplicate IDs in input", async () => {
      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [],
      });

      const existingIds = await AgentModel.existsBatch([
        agent.id,
        agent.id,
        agent.id,
      ]);

      expect(existingIds.size).toBe(1);
      expect(existingIds.has(agent.id)).toBe(true);
    });
  });

  describe("Access Control", () => {
    test("can create agent with team assignments", async ({
      makeUser,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [team.id],
      });

      expect(agent.teams).toHaveLength(1);
      expect(agent.teams[0]).toMatchObject({ id: team.id, name: team.name });
    });

    test("admin can see all agents", async ({ makeAdmin }) => {
      const admin = await makeAdmin();

      await AgentModel.create({ name: "Agent 1", teams: [] });
      await AgentModel.create({ name: "Agent 2", teams: [] });
      await AgentModel.create({ name: "Agent 3", teams: [] });

      const agents = await AgentModel.findAll(admin.id, true);
      // Expecting 4: 3 created + 1 default agent from migration
      expect(agents).toHaveLength(4);
    });

    test("member only sees agents in their teams", async ({
      makeUser,
      makeAdmin,
      makeOrganization,
      makeTeam,
    }) => {
      const user1 = await makeUser();
      const user2 = await makeUser();
      const admin = await makeAdmin();
      const org = await makeOrganization();

      // Create two teams
      const team1 = await makeTeam(org.id, admin.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, admin.id, { name: "Team 2" });

      // Add user1 to team1, user2 to team2
      await TeamModel.addMember(team1.id, user1.id);
      await TeamModel.addMember(team2.id, user2.id);

      // Create agents assigned to different teams
      const agent1 = await AgentModel.create({
        name: "Agent 1",
        teams: [team1.id],
      });
      await AgentModel.create({
        name: "Agent 2",
        teams: [team2.id],
      });
      await AgentModel.create({
        name: "Agent 3",
        teams: [],
      });

      // user1 only has access to agent1 (via team1)
      const agents = await AgentModel.findAll(user1.id, false);
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe(agent1.id);
    });

    test("member with no team membership sees empty list", async ({
      makeUser,
      makeAdmin,
      makeOrganization,
      makeTeam,
    }) => {
      const user1 = await makeUser();
      const user2 = await makeUser();
      const admin = await makeAdmin();
      const org = await makeOrganization();

      const team = await makeTeam(org.id, admin.id);
      await TeamModel.addMember(team.id, user1.id);

      await AgentModel.create({
        name: "Agent 1",
        teams: [team.id],
      });

      // user2 is not in any team
      const agents = await AgentModel.findAll(user2.id, false);
      expect(agents).toHaveLength(0);
    });

    test("findById returns agent for admin", async ({ makeAdmin }) => {
      const admin = await makeAdmin();

      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [],
      });

      const foundAgent = await AgentModel.findById(agent.id, admin.id, true);
      expect(foundAgent).not.toBeNull();
      expect(foundAgent?.id).toBe(agent.id);
    });

    test("findById returns agent for user in assigned team", async ({
      makeUser,
      makeAdmin,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const admin = await makeAdmin();
      const org = await makeOrganization();

      const team = await makeTeam(org.id, admin.id);
      await TeamModel.addMember(team.id, user.id);

      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [team.id],
      });

      const foundAgent = await AgentModel.findById(agent.id, user.id, false);
      expect(foundAgent).not.toBeNull();
      expect(foundAgent?.id).toBe(agent.id);
    });

    test("findById returns null for user not in assigned teams", async ({
      makeUser,
      makeAdmin,
      makeOrganization,
      makeTeam,
    }) => {
      const user1 = await makeUser();
      const user2 = await makeUser();
      const admin = await makeAdmin();
      const org = await makeOrganization();

      const team = await makeTeam(org.id, admin.id);
      await TeamModel.addMember(team.id, user1.id);

      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [team.id],
      });

      const foundAgent = await AgentModel.findById(agent.id, user2.id, false);
      expect(foundAgent).toBeNull();
    });

    test("update syncs team assignments correctly", async ({
      makeAdmin,
      makeOrganization,
      makeTeam,
    }) => {
      const admin = await makeAdmin();
      const org = await makeOrganization();

      const team1 = await makeTeam(org.id, admin.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, admin.id, { name: "Team 2" });

      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [team1.id],
      });

      expect(agent.teams).toHaveLength(1);
      expect(agent.teams[0]).toMatchObject({ id: team1.id, name: team1.name });

      // Update to only include team2
      const updatedAgent = await AgentModel.update(agent.id, {
        teams: [team2.id],
      });

      expect(updatedAgent?.teams).toHaveLength(1);
      expect(updatedAgent?.teams[0]).toMatchObject({
        id: team2.id,
        name: team2.name,
      });
      expect(updatedAgent?.teams.some((t) => t.id === team1.id)).toBe(false);
    });

    test("update without teams keeps existing assignments", async ({
      makeAdmin,
      makeOrganization,
      makeTeam,
    }) => {
      const admin = await makeAdmin();
      const org = await makeOrganization();

      const team = await makeTeam(org.id, admin.id);

      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [team.id],
      });

      const initialTeams = agent.teams;

      // Update only the name
      const updatedAgent = await AgentModel.update(agent.id, {
        name: "Updated Name",
      });

      expect(updatedAgent?.name).toBe("Updated Name");
      expect(updatedAgent?.teams).toEqual(initialTeams);
    });

    test("teams is always populated in responses", async ({
      makeAdmin,
      makeOrganization,
      makeTeam,
    }) => {
      const admin = await makeAdmin();
      const org = await makeOrganization();

      const team = await makeTeam(org.id, admin.id);

      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [team.id],
      });

      expect(agent.teams).toBeDefined();
      expect(Array.isArray(agent.teams)).toBe(true);
      expect(agent.teams).toHaveLength(1);

      const foundAgent = await AgentModel.findById(agent.id);
      expect(foundAgent?.teams).toBeDefined();
      expect(Array.isArray(foundAgent?.teams)).toBe(true);
    });
  });

  describe("Team Assignment Validation", () => {
    test("admin can create agent without any team", async () => {
      const agent = await AgentModel.create({
        name: "No Team Agent",
        teams: [],
      });

      expect(agent.teams).toHaveLength(0);

      // Verify agent is accessible (admins can see all agents)
      const foundAgent = await AgentModel.findById(agent.id);
      expect(foundAgent).not.toBeNull();
    });

    test("admin can create agent with any team regardless of membership", async ({
      makeAdmin,
      makeOrganization,
      makeTeam,
    }) => {
      const admin = await makeAdmin();
      const org = await makeOrganization();

      // Create a team where admin is NOT a member
      const team = await makeTeam(org.id, admin.id, {
        name: "Team Admin Not In",
      });
      // Note: makeTeam creates team but doesn't automatically add the creator as member

      const agent = await AgentModel.create({
        name: "Admin Created Agent",
        teams: [team.id],
      });

      expect(agent.teams).toHaveLength(1);
      expect(agent.teams[0].id).toBe(team.id);
    });

    test("non-admin user can only see agents in teams they belong to", async ({
      makeUser,
      makeAdmin,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const admin = await makeAdmin();
      const org = await makeOrganization();

      const userTeam = await makeTeam(org.id, admin.id, { name: "User Team" });
      const otherTeam = await makeTeam(org.id, admin.id, {
        name: "Other Team",
      });

      // Add user to userTeam only
      await TeamModel.addMember(userTeam.id, user.id);

      // Create agents in different teams
      const userTeamAgent = await AgentModel.create({
        name: "User Team Agent",
        teams: [userTeam.id],
      });
      await AgentModel.create({
        name: "Other Team Agent",
        teams: [otherTeam.id],
      });
      await AgentModel.create({
        name: "No Team Agent",
        teams: [],
      });

      // Non-admin user should only see agent in their team
      const agents = await AgentModel.findAll(user.id, false);
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe(userTeamAgent.id);
    });

    test("non-admin user cannot see agents with no team", async ({
      makeUser,
      makeAdmin,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const admin = await makeAdmin();
      const org = await makeOrganization();

      const userTeam = await makeTeam(org.id, admin.id);
      await TeamModel.addMember(userTeam.id, user.id);

      // Create agent with no teams
      await AgentModel.create({
        name: "No Team Agent",
        teams: [],
      });

      // Non-admin user should not see agent with no teams
      const agents = await AgentModel.findAll(user.id, false);
      // Only agents in user's team should be visible
      expect(agents.every((a) => a.teams.length > 0)).toBe(true);
    });

    test("user with no team membership sees empty list", async ({
      makeUser,
      makeAdmin,
      makeOrganization,
      makeTeam,
    }) => {
      const userWithNoTeam = await makeUser();
      const admin = await makeAdmin();
      const org = await makeOrganization();

      const team = await makeTeam(org.id, admin.id);

      // Create agents with and without teams
      await AgentModel.create({
        name: "Agent in Team",
        teams: [team.id],
      });
      await AgentModel.create({
        name: "Agent without Team",
        teams: [],
      });

      // User with no team membership should see nothing
      const agents = await AgentModel.findAll(userWithNoTeam.id, false);
      expect(agents).toHaveLength(0);
    });

    test("getUserTeamIds returns correct teams for validation", async ({
      makeUser,
      makeAdmin,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const admin = await makeAdmin();
      const org = await makeOrganization();

      const team1 = await makeTeam(org.id, admin.id, { name: "Team 1" });
      const team2 = await makeTeam(org.id, admin.id, { name: "Team 2" });
      const team3 = await makeTeam(org.id, admin.id, { name: "Team 3" });

      // Add user to team1 and team2 only
      await TeamModel.addMember(team1.id, user.id);
      await TeamModel.addMember(team2.id, user.id);

      const userTeamIds = await TeamModel.getUserTeamIds(user.id);

      // User should be in exactly 2 teams
      expect(userTeamIds).toHaveLength(2);
      expect(userTeamIds).toContain(team1.id);
      expect(userTeamIds).toContain(team2.id);
      expect(userTeamIds).not.toContain(team3.id);

      // Creating an agent with team1 should work (user is member)
      const agent = await AgentModel.create({
        name: "Valid Agent",
        teams: [team1.id],
      });
      expect(agent.teams).toHaveLength(1);
      expect(agent.teams[0].id).toBe(team1.id);
    });
  });

  describe("Label Ordering", () => {
    test("labels are returned in alphabetical order by key", async () => {
      // Create an agent with labels in non-alphabetical order
      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [],
        labels: [
          { key: "region", value: "us-west-2" },
          { key: "environment", value: "production" },
          { key: "team", value: "engineering" },
        ],
      });

      // Verify labels are returned in alphabetical order
      expect(agent.labels).toHaveLength(3);
      expect(agent.labels[0].key).toBe("environment");
      expect(agent.labels[0].value).toBe("production");
      expect(agent.labels[1].key).toBe("region");
      expect(agent.labels[1].value).toBe("us-west-2");
      expect(agent.labels[2].key).toBe("team");
      expect(agent.labels[2].value).toBe("engineering");
    });

    test("findById returns labels in alphabetical order", async () => {
      // Create an agent with labels
      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [],
        labels: [
          { key: "zebra", value: "last" },
          { key: "alpha", value: "first" },
          { key: "beta", value: "second" },
        ],
      });

      // Retrieve the agent by ID
      const foundAgent = await AgentModel.findById(agent.id);

      if (!foundAgent) {
        throw new Error("Agent not found");
      }

      expect(foundAgent.labels).toHaveLength(3);
      expect(foundAgent.labels[0].key).toBe("alpha");
      expect(foundAgent.labels[1].key).toBe("beta");
      expect(foundAgent.labels[2].key).toBe("zebra");
    });

    test("findAll returns labels in alphabetical order for all agents", async () => {
      // Create multiple agents with labels
      await AgentModel.create({
        name: "Agent 1",
        teams: [],
        labels: [
          { key: "environment", value: "prod" },
          { key: "application", value: "web" },
        ],
      });

      await AgentModel.create({
        name: "Agent 2",
        teams: [],
        labels: [
          { key: "zone", value: "us-east" },
          { key: "deployment", value: "blue" },
        ],
      });

      const agents = await AgentModel.findAll();

      // Expecting 3: 2 created + 1 default agent from migration
      expect(agents).toHaveLength(3);

      // Check first agent's labels are sorted
      const agent1 = agents.find((a) => a.name === "Agent 1");
      if (!agent1) {
        throw new Error("Agent 1 not found");
      }

      expect(agent1.labels[0].key).toBe("application");
      expect(agent1.labels[1].key).toBe("environment");

      // Check second agent's labels are sorted
      const agent2 = agents.find((a) => a.name === "Agent 2");
      if (!agent2) {
        throw new Error("Agent 2 not found");
      }

      expect(agent2.labels[0].key).toBe("deployment");
      expect(agent2.labels[1].key).toBe("zone");
    });
  });

  describe("Pagination", () => {
    test("pagination count matches filtered results for non-admin user", async ({
      makeUser,
      makeAdmin,
      makeOrganization,
      makeTeam,
    }) => {
      const user = await makeUser();
      const admin = await makeAdmin();
      const org = await makeOrganization();

      // Create team and add user to it
      const team = await makeTeam(org.id, admin.id, { name: "Team 1" });
      await TeamModel.addMember(team.id, user.id);

      // Create 4 agents: 1 with team assignment, 3 without
      await AgentModel.create({
        name: "Agent 1",
        teams: [team.id],
      });
      await AgentModel.create({
        name: "Agent 2",
        teams: [],
      });
      await AgentModel.create({
        name: "Agent 3",
        teams: [],
      });
      await AgentModel.create({
        name: "Agent 4",
        teams: [],
      });

      // Query as non-admin user (should only see Agent 1)
      const result = await AgentModel.findAllPaginated(
        { limit: 20, offset: 0 },
        { sortBy: "createdAt", sortDirection: "desc" },
        {},
        user.id,
        false, // not admin
      );

      // The bug: total count should match the actual number of accessible agents
      expect(result.data).toHaveLength(1); // Only Agent 1 is accessible
      expect(result.pagination.total).toBe(1); // Total should also be 1, not 5 (including default agent)
      expect(result.data[0].name).toBe("Agent 1");
    });

    test("pagination count includes all agents for admin", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();

      // Create 3 agents (+ 1 default from migration = 4 total)
      await AgentModel.create({
        name: "Agent 1",
        teams: [],
      });
      await AgentModel.create({
        name: "Agent 2",
        teams: [],
      });
      await AgentModel.create({
        name: "Agent 3",
        teams: [],
      });

      // Query as admin (should see all agents)
      const result = await AgentModel.findAllPaginated(
        { limit: 20, offset: 0 },
        { sortBy: "createdAt", sortDirection: "desc" },
        {},
        admin.id,
        true, // is admin
      );

      expect(result.data.length).toBe(result.pagination.total);
      expect(result.pagination.total).toBe(4); // 3 + 1 default
    });

    test("pagination works correctly when agents have many tools", async ({
      makeAdmin,
      makeTool,
      makeAgentTool,
    }) => {
      const admin = await makeAdmin();

      // Create 5 agents with varying numbers of tools
      const agent1 = await AgentModel.create({
        name: "Agent 1",
        teams: [],
      });
      const agent2 = await AgentModel.create({
        name: "Agent 2",
        teams: [],
      });
      const agent3 = await AgentModel.create({
        name: "Agent 3",
        teams: [],
      });
      await AgentModel.create({
        name: "Agent 4",
        teams: [],
      });
      await AgentModel.create({
        name: "Agent 5",
        teams: [],
      });

      // Give agent1 and agent2 many tools (50+ each) via junction table
      for (let i = 0; i < 50; i++) {
        const tool = await makeTool({
          name: `tool_agent1_${i}`,
          description: `Tool ${i} for agent 1`,
          parameters: {},
        });
        await makeAgentTool(agent1.id, tool.id);
      }

      for (let i = 0; i < 50; i++) {
        const tool = await makeTool({
          name: `tool_agent2_${i}`,
          description: `Tool ${i} for agent 2`,
          parameters: {},
        });
        await makeAgentTool(agent2.id, tool.id);
      }

      // Give agent3 a few tools via junction table
      for (let i = 0; i < 5; i++) {
        const tool = await makeTool({
          name: `tool_agent3_${i}`,
          description: `Tool ${i} for agent 3`,
          parameters: {},
        });
        await makeAgentTool(agent3.id, tool.id);
      }

      // agent4 and agent5 have no tools (just the default archestra tools)

      // Query with limit=20 - this should return all 6 agents (5 + 1 default)
      // Bug scenario: if LIMIT was applied to joined rows, we'd only get 2 agents
      const result = await AgentModel.findAllPaginated(
        { limit: 20, offset: 0 },
        { sortBy: "createdAt", sortDirection: "desc" },
        {},
        admin.id,
        true,
      );

      expect(result.data).toHaveLength(6); // 5 created + 1 default
      expect(result.pagination.total).toBe(6);

      // Verify all agents are returned (not just the first 2 with many tools)
      const agentNames = result.data.map((a) => a.name).sort();
      expect(agentNames).toContain("Agent 1");
      expect(agentNames).toContain("Agent 2");
      expect(agentNames).toContain("Agent 3");
      expect(agentNames).toContain("Agent 4");
      expect(agentNames).toContain("Agent 5");
    });

    test("pagination limit applies to agents, not tool rows", async ({
      makeAdmin,
      makeTool,
      makeAgentTool,
    }) => {
      const admin = await makeAdmin();

      // Create 3 agents
      const agent1 = await AgentModel.create({
        name: "Agent A",
        teams: [],
      });
      await AgentModel.create({
        name: "Agent B",
        teams: [],
      });
      await AgentModel.create({
        name: "Agent C",
        teams: [],
      });

      // Give agent1 many tools via junction table
      for (let i = 0; i < 30; i++) {
        const tool = await makeTool({
          name: `tool_${i}`,
          description: `Tool ${i}`,
          parameters: {},
        });
        await makeAgentTool(agent1.id, tool.id);
      }

      // Query with limit=2 - should return exactly 2 agents
      const result = await AgentModel.findAllPaginated(
        { limit: 2, offset: 0 },
        { sortBy: "name", sortDirection: "asc" },
        {},
        admin.id,
        true,
      );

      expect(result.data).toHaveLength(2);
      expect(result.data[0].name).toBe("Agent A");
      expect(result.data[1].name).toBe("Agent B");

      // Verify each agent has all their regular tools loaded (excluding Archestra tools)
      expect(result.data[0].tools.length).toBe(30); // Only the 30 regular tools, Archestra tools excluded
    });

    test("pagination with different sort options returns correct agent count", async ({
      makeAdmin,
      makeOrganization,
      makeTeam,
      makeTool,
      makeAgentTool,
    }) => {
      const admin = await makeAdmin();
      const org = await makeOrganization();

      const team1 = await makeTeam(org.id, admin.id, { name: "Team A" });
      const team2 = await makeTeam(org.id, admin.id, { name: "Team B" });

      // Create 4 agents with varying tools and teams
      const agent1 = await AgentModel.create({
        name: "Zebra",
        teams: [team1.id],
      });
      const agent2 = await AgentModel.create({
        name: "Alpha",
        teams: [team2.id],
      });
      await AgentModel.create({
        name: "Beta",
        teams: [team1.id],
      });
      await AgentModel.create({
        name: "Gamma",
        teams: [],
      });

      // Give different numbers of tools via junction table
      for (let i = 0; i < 20; i++) {
        const tool = await makeTool({
          name: `tool_zebra_${i}`,
          description: `Tool ${i}`,
          parameters: {},
        });
        await makeAgentTool(agent1.id, tool.id);
      }

      for (let i = 0; i < 5; i++) {
        const tool = await makeTool({
          name: `tool_alpha_${i}`,
          description: `Tool ${i}`,
          parameters: {},
        });
        await makeAgentTool(agent2.id, tool.id);
      }

      // Test sortBy name
      const resultByName = await AgentModel.findAllPaginated(
        { limit: 10, offset: 0 },
        { sortBy: "name", sortDirection: "asc" },
        {},
        admin.id,
        true,
      );
      expect(resultByName.data).toHaveLength(5); // 4 + 1 default
      expect(resultByName.data[0].name).toBe("Alpha");

      // Test sortBy createdAt
      const resultByDate = await AgentModel.findAllPaginated(
        { limit: 10, offset: 0 },
        { sortBy: "createdAt", sortDirection: "desc" },
        {},
        admin.id,
        true,
      );
      expect(resultByDate.data).toHaveLength(5);

      // Test sortBy toolsCount
      const resultByToolsCount = await AgentModel.findAllPaginated(
        { limit: 10, offset: 0 },
        { sortBy: "toolsCount", sortDirection: "desc" },
        {},
        admin.id,
        true,
      );
      expect(resultByToolsCount.data).toHaveLength(5);
      // Agent with most tools should be first
      expect(resultByToolsCount.data[0].name).toBe("Zebra");

      // Test sortBy team
      const resultByTeam = await AgentModel.findAllPaginated(
        { limit: 10, offset: 0 },
        { sortBy: "team", sortDirection: "asc" },
        {},
        admin.id,
        true,
      );
      expect(resultByTeam.data).toHaveLength(5);
    });

    test("pagination offset works correctly with many tools", async ({
      makeAdmin,
      makeTool,
      makeAgentTool,
    }) => {
      const admin = await makeAdmin();

      // Create 5 agents, each with many tools
      const agentIds: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const agent = await AgentModel.create({
          name: `Agent ${i}`,
          teams: [],
        });
        agentIds.push(agent.id);

        // Give each agent 20 tools via junction table
        for (let j = 0; j < 20; j++) {
          const tool = await makeTool({
            name: `tool_${i}_${j}`,
            description: `Tool ${j}`,
            parameters: {},
          });
          await makeAgentTool(agent.id, tool.id);
        }
      }

      // First page (limit=2, offset=0)
      const page1 = await AgentModel.findAllPaginated(
        { limit: 2, offset: 0 },
        { sortBy: "createdAt", sortDirection: "asc" },
        {},
        admin.id,
        true,
      );

      expect(page1.data).toHaveLength(2);
      expect(page1.pagination.total).toBe(6); // 5 + 1 default

      // Second page (limit=2, offset=2)
      const page2 = await AgentModel.findAllPaginated(
        { limit: 2, offset: 2 },
        { sortBy: "createdAt", sortDirection: "asc" },
        {},
        admin.id,
        true,
      );

      expect(page2.data).toHaveLength(2);
      expect(page2.pagination.total).toBe(6);

      // Verify no overlap between pages
      const page1Ids = page1.data.map((a) => a.id);
      const page2Ids = page2.data.map((a) => a.id);
      const intersection = page1Ids.filter((id) => page2Ids.includes(id));
      expect(intersection).toHaveLength(0);
    });
  });

  describe("Archestra Tools Exclusion", () => {
    test("findAllPaginated excludes Archestra MCP tools from tools array", async ({
      makeAdmin,
      makeTool,
      makeAgentTool,
    }) => {
      const admin = await makeAdmin();

      // Create an agent
      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [],
      });

      // Add some regular tools
      for (let i = 0; i < 3; i++) {
        const tool = await makeTool({
          name: `regular_tool_${i}`,
          description: `Regular tool ${i}`,
          parameters: {},
        });
        await makeAgentTool(agent.id, tool.id);
      }

      // Add some Archestra MCP tools (these should be excluded)
      for (let i = 0; i < 5; i++) {
        const tool = await makeTool({
          name: `archestra__archestra_tool_${i}`,
          description: `Archestra tool ${i}`,
          parameters: {},
        });
        await makeAgentTool(agent.id, tool.id);
      }

      // Query the agent
      const result = await AgentModel.findAllPaginated(
        { limit: 10, offset: 0 },
        { sortBy: "createdAt", sortDirection: "desc" },
        {},
        admin.id,
        true,
      );

      // Find our test agent
      const testAgent = result.data.find((a) => a.name === "Test Agent");
      expect(testAgent).toBeDefined();

      // Should only include the 3 regular tools, not the 5 Archestra tools
      expect(testAgent?.tools).toHaveLength(3);

      // Verify all tools in the array are regular tools (not Archestra)
      for (const tool of testAgent?.tools ?? []) {
        expect(tool.name).not.toMatch(/^archestra__/);
      }

      // Verify the regular tools are there
      const toolNames = testAgent?.tools.map((t) => t.name).sort();
      expect(toolNames).toEqual([
        "regular_tool_0",
        "regular_tool_1",
        "regular_tool_2",
      ]);
    });

    test("sorting by toolsCount excludes Archestra tools from count", async ({
      makeAdmin,
      makeTool,
      makeAgentTool,
    }) => {
      const admin = await makeAdmin();

      // Create two agents
      const agent1 = await AgentModel.create({
        name: "Agent with 5 regular tools",
        teams: [],
      });

      const agent2 = await AgentModel.create({
        name: "Agent with 2 regular tools",
        teams: [],
      });

      // Give agent1 5 regular tools + 10 Archestra tools
      for (let i = 0; i < 5; i++) {
        const tool = await makeTool({
          name: `regular_tool_agent1_${i}`,
          description: `Regular tool ${i}`,
          parameters: {},
        });
        await makeAgentTool(agent1.id, tool.id);
      }

      for (let i = 0; i < 10; i++) {
        const tool = await makeTool({
          name: `archestra__tool_agent1_${i}`,
          description: `Archestra tool ${i}`,
          parameters: {},
        });
        await makeAgentTool(agent1.id, tool.id);
      }

      // Give agent2 2 regular tools + 20 Archestra tools
      for (let i = 0; i < 2; i++) {
        const tool = await makeTool({
          name: `regular_tool_agent2_${i}`,
          description: `Regular tool ${i}`,
          parameters: {},
        });
        await makeAgentTool(agent2.id, tool.id);
      }

      for (let i = 0; i < 20; i++) {
        const tool = await makeTool({
          name: `archestra__tool_agent2_${i}`,
          description: `Archestra tool ${i}`,
          parameters: {},
        });
        await makeAgentTool(agent2.id, tool.id);
      }

      // Sort by toolsCount descending - agent1 should come first (5 > 2 regular tools)
      const result = await AgentModel.findAllPaginated(
        { limit: 10, offset: 0 },
        { sortBy: "toolsCount", sortDirection: "desc" },
        {},
        admin.id,
        true,
      );

      // Find our test agents
      const testAgent1 = result.data.find(
        (a) => a.name === "Agent with 5 regular tools",
      );
      const testAgent2 = result.data.find(
        (a) => a.name === "Agent with 2 regular tools",
      );

      expect(testAgent1).toBeDefined();
      expect(testAgent2).toBeDefined();

      // Verify the tools count excludes Archestra tools
      expect(testAgent1?.tools).toHaveLength(5); // Only regular tools
      expect(testAgent2?.tools).toHaveLength(2); // Only regular tools

      // Verify sorting order based on regular tools count (not total tools including Archestra)
      const agent1Index = result.data.findIndex(
        (a) => a.name === "Agent with 5 regular tools",
      );
      const agent2Index = result.data.findIndex(
        (a) => a.name === "Agent with 2 regular tools",
      );

      // agent1 should come before agent2 when sorted by toolsCount desc
      expect(agent1Index).toBeLessThan(agent2Index);
    });

    test("agents with only Archestra tools show 0 tools", async ({
      makeAdmin,
      makeTool,
      makeAgentTool,
    }) => {
      const admin = await makeAdmin();

      // Create an agent with only Archestra tools
      const agent = await AgentModel.create({
        name: "Archestra Only Agent",
        teams: [],
      });

      // Add only Archestra MCP tools
      for (let i = 0; i < 3; i++) {
        const tool = await makeTool({
          name: `archestra__only_archestra_${i}`,
          description: `Archestra tool ${i}`,
          parameters: {},
        });
        await makeAgentTool(agent.id, tool.id);
      }

      // Query the agent
      const result = await AgentModel.findAllPaginated(
        { limit: 10, offset: 0 },
        { sortBy: "createdAt", sortDirection: "desc" },
        {},
        admin.id,
        true,
      );

      // Find our test agent
      const testAgent = result.data.find(
        (a) => a.name === "Archestra Only Agent",
      );
      expect(testAgent).toBeDefined();

      // Should show 0 tools since all were Archestra tools
      expect(testAgent?.tools).toHaveLength(0);
    });

    test("exclusion pattern only matches double underscore prefix", async ({
      makeAdmin,
      makeTool,
      makeAgentTool,
    }) => {
      const admin = await makeAdmin();

      // Create an agent
      const agent = await AgentModel.create({
        name: "Pattern Test Agent",
        teams: [],
      });

      // Create tools with double underscore (should be excluded)
      const doubleUnderscoreTool = await makeTool({
        name: "archestra__pattern_test_tool",
        description: "Archestra tool",
        parameters: {},
      });

      // Create tools with similar names that should NOT be excluded
      const singleUnderscoreTool = await makeTool({
        name: "archestra_pattern_single",
        description: "Single underscore tool",
        parameters: {},
      });
      const noUnderscoreTool = await makeTool({
        name: "archestrapatterntest",
        description: "No underscore tool",
        parameters: {},
      });
      const regularTool = await makeTool({
        name: "regular_pattern_tool",
        description: "Regular tool",
        parameters: {},
      });

      await makeAgentTool(agent.id, doubleUnderscoreTool.id);
      await makeAgentTool(agent.id, singleUnderscoreTool.id);
      await makeAgentTool(agent.id, noUnderscoreTool.id);
      await makeAgentTool(agent.id, regularTool.id);

      // Query the agent
      const result = await AgentModel.findAllPaginated(
        { limit: 10, offset: 0 },
        { sortBy: "createdAt", sortDirection: "desc" },
        {},
        admin.id,
        true,
      );

      // Find our test agent
      const testAgent = result.data.find(
        (a) => a.name === "Pattern Test Agent",
      );
      expect(testAgent).toBeDefined();

      // Should have 3 tools (excludes only archestra__pattern_test_tool)
      expect(testAgent?.tools).toHaveLength(3);

      const toolNames = testAgent?.tools.map((t) => t.name) ?? [];
      expect(toolNames).toContain("archestra_pattern_single");
      expect(toolNames).toContain("archestrapatterntest");
      expect(toolNames).toContain("regular_pattern_tool");
      expect(toolNames).not.toContain("archestra__pattern_test_tool");
    });

    test("sortBy toolsCount correctly excludes only double underscore prefix", async ({
      makeAdmin,
      makeTool,
      makeAgentTool,
    }) => {
      const admin = await makeAdmin();

      // Create two agents
      const agent1 = await AgentModel.create({
        name: "Agent with mixed tools",
        teams: [],
      });

      const agent2 = await AgentModel.create({
        name: "Agent with single underscore",
        teams: [],
      });

      // Give agent1: 1 regular + 5 archestra__ tools = 1 counted
      const regularTool = await makeTool({
        name: "toolscount_regular_tool",
        description: "Regular tool",
        parameters: {},
      });
      await makeAgentTool(agent1.id, regularTool.id);

      for (let i = 0; i < 5; i++) {
        const tool = await makeTool({
          name: `archestra__toolscount_${i}`,
          description: `Archestra tool ${i}`,
          parameters: {},
        });
        await makeAgentTool(agent1.id, tool.id);
      }

      // Give agent2: 3 archestra_ (single underscore) tools = 3 counted
      for (let i = 0; i < 3; i++) {
        const tool = await makeTool({
          name: `archestra_single_${i}`,
          description: `Single underscore tool ${i}`,
          parameters: {},
        });
        await makeAgentTool(agent2.id, tool.id);
      }

      // Sort by toolsCount descending
      const result = await AgentModel.findAllPaginated(
        { limit: 10, offset: 0 },
        { sortBy: "toolsCount", sortDirection: "desc" },
        {},
        admin.id,
        true,
      );

      const agent1Result = result.data.find(
        (a) => a.name === "Agent with mixed tools",
      );
      const agent2Result = result.data.find(
        (a) => a.name === "Agent with single underscore",
      );

      expect(agent1Result).toBeDefined();
      expect(agent2Result).toBeDefined();

      // agent1 should have 1 tool counted (archestra__ excluded)
      expect(agent1Result?.tools).toHaveLength(1);

      // agent2 should have 3 tools counted (archestra_ NOT excluded)
      expect(agent2Result?.tools).toHaveLength(3);

      // agent2 should come before agent1 in sort order (3 > 1)
      const agent1Index = result.data.findIndex(
        (a) => a.name === "Agent with mixed tools",
      );
      const agent2Index = result.data.findIndex(
        (a) => a.name === "Agent with single underscore",
      );

      expect(agent2Index).toBeLessThan(agent1Index);
    });
  });

  describe("findById Junction Table", () => {
    test("findById returns tools from junction table", async ({
      makeTool,
      makeAgentTool,
    }) => {
      // Create an agent
      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [],
      });

      // Add tools via the junction table (agent_tools)
      const tool1 = await makeTool({
        name: "junction_tool_1",
        description: "Tool 1",
        parameters: {},
      });
      const tool2 = await makeTool({
        name: "junction_tool_2",
        description: "Tool 2",
        parameters: {},
      });
      const tool3 = await makeTool({
        name: "junction_tool_3",
        description: "Tool 3",
        parameters: {},
      });

      await makeAgentTool(agent.id, tool1.id);
      await makeAgentTool(agent.id, tool2.id);
      await makeAgentTool(agent.id, tool3.id);

      // Retrieve the agent by ID
      const foundAgent = await AgentModel.findById(agent.id);

      expect(foundAgent).not.toBeNull();
      expect(foundAgent?.tools).toHaveLength(3);

      const toolNames = foundAgent?.tools.map((t) => t.name).sort();
      expect(toolNames).toEqual([
        "junction_tool_1",
        "junction_tool_2",
        "junction_tool_3",
      ]);
    });

    test("findById excludes Archestra MCP tools", async ({
      makeTool,
      makeAgentTool,
    }) => {
      // Create an agent
      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [],
      });

      // Add regular tools
      const regularTool1 = await makeTool({
        name: "findbyid_regular_tool_1",
        description: "Regular tool 1",
        parameters: {},
      });
      const regularTool2 = await makeTool({
        name: "findbyid_regular_tool_2",
        description: "Regular tool 2",
        parameters: {},
      });

      // Add Archestra tools (should be excluded)
      const archestraTool1 = await makeTool({
        name: "archestra__findbyid_tool_1",
        description: "Archestra tool 1",
        parameters: {},
      });
      const archestraTool2 = await makeTool({
        name: "archestra__findbyid_tool_2",
        description: "Archestra tool 2",
        parameters: {},
      });

      await makeAgentTool(agent.id, regularTool1.id);
      await makeAgentTool(agent.id, regularTool2.id);
      await makeAgentTool(agent.id, archestraTool1.id);
      await makeAgentTool(agent.id, archestraTool2.id);

      // Retrieve the agent by ID
      const foundAgent = await AgentModel.findById(agent.id);

      expect(foundAgent).not.toBeNull();
      // Should only include 2 regular tools, not the Archestra tools
      expect(foundAgent?.tools).toHaveLength(2);

      // Verify all returned tools are regular tools
      for (const tool of foundAgent?.tools ?? []) {
        expect(tool.name).not.toMatch(/^archestra__/);
      }

      const toolNames = foundAgent?.tools.map((t) => t.name).sort();
      expect(toolNames).toEqual([
        "findbyid_regular_tool_1",
        "findbyid_regular_tool_2",
      ]);
    });

    test("findById returns empty tools array when agent has no tools", async () => {
      // Create an agent with no tools
      const agent = await AgentModel.create({
        name: "No Tools Agent",
        teams: [],
      });

      const foundAgent = await AgentModel.findById(agent.id);

      expect(foundAgent).not.toBeNull();
      expect(foundAgent?.tools).toHaveLength(0);
    });

    test("findById returns empty tools array when agent has only Archestra tools", async ({
      makeTool,
      makeAgentTool,
    }) => {
      // Create an agent
      const agent = await AgentModel.create({
        name: "Archestra Only Agent",
        teams: [],
      });

      // Add only Archestra tools
      const archestraTool = await makeTool({
        name: "archestra__some_tool",
        description: "Archestra tool",
        parameters: {},
      });
      await makeAgentTool(agent.id, archestraTool.id);

      const foundAgent = await AgentModel.findById(agent.id);

      expect(foundAgent).not.toBeNull();
      expect(foundAgent?.tools).toHaveLength(0);
    });
  });

  describe("Default Archestra Tools Assignment", () => {
    test("new agent has artifact_write and todo_write tools assigned by default", async ({
      seedAndAssignArchestraTools,
      makeAgent,
    }) => {
      // First seed Archestra tools (simulates app startup)
      const existingAgent = await makeAgent();
      await seedAndAssignArchestraTools(existingAgent.id);

      // Create a new agent - should have default tools assigned
      const agent = await AgentModel.create({
        name: "Agent with Default Tools",
        teams: [],
      });

      // Verify the agent has the default Archestra tools assigned
      const toolNames = agent.tools.map((t) => t.name);
      expect(toolNames).toContain(TOOL_ARTIFACT_WRITE_FULL_NAME);
      expect(toolNames).toContain(TOOL_TODO_WRITE_FULL_NAME);
    });

    test("new agent returns assigned tools without Archestra prefix filtering", async ({
      seedAndAssignArchestraTools,
      makeAgent,
    }) => {
      // First seed Archestra tools
      const existingAgent = await makeAgent();
      await seedAndAssignArchestraTools(existingAgent.id);

      // Create a new agent
      const agent = await AgentModel.create({
        name: "Test Default Tools Agent",
        teams: [],
      });

      // The create method should return the assigned tools
      expect(agent.tools.length).toBeGreaterThanOrEqual(2);

      // Verify artifact_write and todo_write are present
      const hasArtifactWrite = agent.tools.some(
        (t) => t.name === TOOL_ARTIFACT_WRITE_FULL_NAME,
      );
      const hasTodoWrite = agent.tools.some(
        (t) => t.name === TOOL_TODO_WRITE_FULL_NAME,
      );

      expect(hasArtifactWrite).toBe(true);
      expect(hasTodoWrite).toBe(true);
    });
  });

  describe("getAgentOrCreateDefault Junction Table", () => {
    test("getAgentOrCreateDefault returns tools from junction table", async ({
      makeTool,
      makeAgentTool,
    }) => {
      // Get the default agent
      const defaultAgent = await AgentModel.getAgentOrCreateDefault();

      // Add tools to the default agent via junction table
      const tool1 = await makeTool({
        name: "default_agent_tool_1",
        description: "Tool 1",
        parameters: {},
      });
      const tool2 = await makeTool({
        name: "default_agent_tool_2",
        description: "Tool 2",
        parameters: {},
      });

      await makeAgentTool(defaultAgent.id, tool1.id);
      await makeAgentTool(defaultAgent.id, tool2.id);

      // Get the default agent again - should include the tools
      const foundAgent = await AgentModel.getAgentOrCreateDefault();

      expect(foundAgent).not.toBeNull();
      expect(foundAgent.tools.length).toBeGreaterThanOrEqual(2);

      const toolNames = foundAgent.tools.map((t) => t.name);
      expect(toolNames).toContain("default_agent_tool_1");
      expect(toolNames).toContain("default_agent_tool_2");
    });

    test("getAgentOrCreateDefault excludes Archestra MCP tools", async ({
      makeTool,
      makeAgentTool,
    }) => {
      // Get the default agent
      const defaultAgent = await AgentModel.getAgentOrCreateDefault();

      // Add regular tools
      const regularTool = await makeTool({
        name: "default_regular_tool",
        description: "Regular tool",
        parameters: {},
      });

      // Add Archestra tools (should be excluded)
      const archestraTool = await makeTool({
        name: "archestra__default_tool",
        description: "Archestra tool",
        parameters: {},
      });

      await makeAgentTool(defaultAgent.id, regularTool.id);
      await makeAgentTool(defaultAgent.id, archestraTool.id);

      // Get the default agent again
      const foundAgent = await AgentModel.getAgentOrCreateDefault();

      // Verify Archestra tools are excluded
      for (const tool of foundAgent.tools) {
        expect(tool.name).not.toMatch(/^archestra__/);
      }

      // Verify regular tool is included
      const toolNames = foundAgent.tools.map((t) => t.name);
      expect(toolNames).toContain("default_regular_tool");
    });
  });
});
