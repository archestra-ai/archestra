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

      expect(agent.teams).toContain(team.id);
      expect(agent.teams).toHaveLength(1);
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
      expect(agent.teams).toContain(team1.id);

      // Update to only include team2
      const updatedAgent = await AgentModel.update(agent.id, {
        teams: [team2.id],
      });

      expect(updatedAgent?.teams).toHaveLength(1);
      expect(updatedAgent?.teams).toContain(team2.id);
      expect(updatedAgent?.teams).not.toContain(team1.id);
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
  });

  describe("use_in_chat filtering", () => {
    test("findAll only returns agents with use_in_chat=true when useInChat: true is passed", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();

      // Create agents with use_in_chat=true (explicitly set)
      const chatAgent1 = await AgentModel.create({
        name: "Chat Agent 1",
        teams: [],
        useInChat: true,
      });
      const chatAgent2 = await AgentModel.create({
        name: "Chat Agent 2",
        teams: [],
        useInChat: true,
      });

      // Create agent with use_in_chat=false
      const nonChatAgent = await AgentModel.create({
        name: "Non-Chat Agent",
        teams: [],
        useInChat: false,
      });

      const agents = await AgentModel.findAll(admin.id, true, {
        useInChat: true,
      });

      // Should only return agents with use_in_chat=true
      expect(agents.some((a) => a.id === nonChatAgent.id)).toBe(false);
      expect(agents.some((a) => a.id === chatAgent1.id)).toBe(true);
      expect(agents.some((a) => a.id === chatAgent2.id)).toBe(true);
      // Verify all returned agents have useInChat=true
      for (const agent of agents) {
        expect(agent.useInChat).toBe(true);
      }
    });

    test("findAll with team filtering respects use_in_chat when useInChat: true is passed", async ({
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

      // Create agent with use_in_chat=true
      const chatAgent = await AgentModel.create({
        name: "Chat Agent",
        teams: [team.id],
        useInChat: true,
      });

      // Create agent with use_in_chat=false
      const nonChatAgent = await AgentModel.create({
        name: "Non-Chat Agent",
        teams: [team.id],
        useInChat: false,
      });

      const agents = await AgentModel.findAll(user.id, false, {
        useInChat: true,
      });

      // User should see the chat agent (and possibly the default agent from migration)
      expect(agents.length).toBeGreaterThanOrEqual(1);
      expect(agents.some((a) => a.id === chatAgent.id)).toBe(true);
      expect(agents.some((a) => a.id === nonChatAgent.id)).toBe(false);
      // Verify all returned agents have useInChat=true
      for (const agent of agents) {
        expect(agent.useInChat).toBe(true);
      }
    });

    test("findAll with useInChat: true only returns chat-enabled agents", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();

      // Create agents with use_in_chat=true
      const chatAgent1 = await AgentModel.create({
        name: "Chat Agent 1",
        teams: [],
        useInChat: true,
      });
      const chatAgent2 = await AgentModel.create({
        name: "Chat Agent 2",
        teams: [],
        useInChat: true,
      });

      // Create agent with use_in_chat=false
      const nonChatAgent = await AgentModel.create({
        name: "Non-Chat Agent",
        teams: [],
        useInChat: false,
      });

      const agents = await AgentModel.findAll(admin.id, true, {
        useInChat: true,
      });

      // Should only return agents with use_in_chat=true
      // Expecting 3: 2 created + 1 default agent from migration
      expect(agents.length).toBeGreaterThanOrEqual(2);
      expect(agents.some((a) => a.id === chatAgent1.id)).toBe(true);
      expect(agents.some((a) => a.id === chatAgent2.id)).toBe(true);
      expect(agents.some((a) => a.id === nonChatAgent.id)).toBe(false);
      // Verify all returned agents have useInChat=true
      for (const agent of agents) {
        expect(agent.useInChat).toBe(true);
      }
    });

    test("findAll with useInChat: false only returns non-chat agents", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();

      // Create agents with use_in_chat=true
      await AgentModel.create({
        name: "Chat Agent 1",
        teams: [],
        useInChat: true,
      });
      await AgentModel.create({
        name: "Chat Agent 2",
        teams: [],
        useInChat: true,
      });

      // Create agent with use_in_chat=false
      const nonChatAgent = await AgentModel.create({
        name: "Non-Chat Agent",
        teams: [],
        useInChat: false,
      });

      const agents = await AgentModel.findAll(admin.id, true, {
        useInChat: false,
      });

      // Should only return agents with use_in_chat=false
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe(nonChatAgent.id);
      expect(agents[0].name).toBe("Non-Chat Agent");
    });

    test("findAll without useInChat option returns all agents", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();

      // Create agents with use_in_chat=true
      const chatAgent1 = await AgentModel.create({
        name: "Chat Agent 1",
        teams: [],
        useInChat: true,
      });
      const chatAgent2 = await AgentModel.create({
        name: "Chat Agent 2",
        teams: [],
        useInChat: true,
      });

      // Create agent with use_in_chat=false
      const nonChatAgent = await AgentModel.create({
        name: "Non-Chat Agent",
        teams: [],
        useInChat: false,
      });

      // Call without the third parameter (should return all)
      const agents = await AgentModel.findAll(admin.id, true);

      // Should return all agents regardless of use_in_chat value
      expect(agents.some((a) => a.id === chatAgent1.id)).toBe(true);
      expect(agents.some((a) => a.id === chatAgent2.id)).toBe(true);
      expect(agents.some((a) => a.id === nonChatAgent.id)).toBe(true);
    });

    test("findAll with useInChat: true and team filtering works correctly", async ({
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

      // Create chat-enabled agent in user's team
      const chatAgent = await AgentModel.create({
        name: "Chat Agent",
        teams: [team.id],
        useInChat: true,
      });

      // Create non-chat agent in user's team
      const nonChatAgent = await AgentModel.create({
        name: "Non-Chat Agent",
        teams: [team.id],
        useInChat: false,
      });

      // Create chat-enabled agent NOT in user's team
      await AgentModel.create({
        name: "Other Chat Agent",
        teams: [],
        useInChat: true,
      });

      const agents = await AgentModel.findAll(user.id, false, {
        useInChat: true,
      });

      // User should only see the chat-enabled agent in their team
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe(chatAgent.id);
      expect(agents.some((a) => a.id === nonChatAgent.id)).toBe(false);
    });

    test("findAll with useInChat: false and team filtering works correctly", async ({
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

      // Create chat-enabled agent in user's team
      await AgentModel.create({
        name: "Chat Agent",
        teams: [team.id],
        useInChat: true,
      });

      // Create non-chat agent in user's team
      const nonChatAgent = await AgentModel.create({
        name: "Non-Chat Agent",
        teams: [team.id],
        useInChat: false,
      });

      // Create non-chat agent NOT in user's team
      await AgentModel.create({
        name: "Other Non-Chat Agent",
        teams: [],
        useInChat: false,
      });

      const agents = await AgentModel.findAll(user.id, false, {
        useInChat: false,
      });

      // User should only see the non-chat agent in their team
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe(nonChatAgent.id);
      expect(agents[0].name).toBe("Non-Chat Agent");
    });

    test("findAll with useInChat: undefined returns all agents", async ({
      makeAdmin,
    }) => {
      const admin = await makeAdmin();

      // Create agents with use_in_chat=true
      const chatAgent1 = await AgentModel.create({
        name: "Chat Agent 1",
        teams: [],
        useInChat: true,
      });
      const chatAgent2 = await AgentModel.create({
        name: "Chat Agent 2",
        teams: [],
        useInChat: true,
      });

      // Create agent with use_in_chat=false
      const nonChatAgent = await AgentModel.create({
        name: "Non-Chat Agent",
        teams: [],
        useInChat: false,
      });

      // Call with useInChat: undefined (should return all)
      const agents = await AgentModel.findAll(admin.id, true, {
        useInChat: undefined,
      });

      // Should return all agents regardless of use_in_chat value
      expect(agents.some((a) => a.id === chatAgent1.id)).toBe(true);
      expect(agents.some((a) => a.id === chatAgent2.id)).toBe(true);
      expect(agents.some((a) => a.id === nonChatAgent.id)).toBe(true);
    });
  });
});
