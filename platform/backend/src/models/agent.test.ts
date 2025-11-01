import {
  createTestAdmin,
  createTestOrganization,
  createTestUser,
} from "@/test-utils";
import AgentModel from "./agent";
import TeamModel from "./team";

describe("AgentModel", () => {
  test("can create an agent", async () => {
    await AgentModel.create({ name: "Test Agent", teams: [] });
    await AgentModel.create({ name: "Test Agent 2", teams: [] });

    expect(await AgentModel.findAll()).toHaveLength(2);
  });

  describe("Access Control", () => {
    test("can create agent with team assignments", async () => {
      const userId = await createTestUser();
      const orgId = await createTestOrganization();
      const team = await TeamModel.create({
        name: "Test Team",
        organizationId: orgId,
        createdBy: userId,
      });

      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [team.id],
      });

      expect(agent.teams).toContain(team.id);
      expect(agent.teams).toHaveLength(1);
    });

    test("admin can see all agents", async () => {
      const adminId = await createTestAdmin();

      await AgentModel.create({ name: "Agent 1", teams: [] });
      await AgentModel.create({ name: "Agent 2", teams: [] });
      await AgentModel.create({ name: "Agent 3", teams: [] });

      const agents = await AgentModel.findAll(adminId, true);
      expect(agents).toHaveLength(3);
    });

    test("member only sees agents in their teams", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();
      const adminId = await createTestAdmin();
      const orgId = await createTestOrganization();

      // Create two teams
      const team1 = await TeamModel.create({
        name: "Team 1",
        organizationId: orgId,
        createdBy: adminId,
      });
      const team2 = await TeamModel.create({
        name: "Team 2",
        organizationId: orgId,
        createdBy: adminId,
      });

      // Add user1 to team1, user2 to team2
      await TeamModel.addMember(team1.id, user1Id);
      await TeamModel.addMember(team2.id, user2Id);

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
      const agents = await AgentModel.findAll(user1Id, false);
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe(agent1.id);
    });

    test("member with no team membership sees empty list", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();
      const adminId = await createTestAdmin();
      const orgId = await createTestOrganization();

      const team = await TeamModel.create({
        name: "Test Team",
        organizationId: orgId,
        createdBy: adminId,
      });
      await TeamModel.addMember(team.id, user1Id);

      await AgentModel.create({
        name: "Agent 1",
        teams: [team.id],
      });

      // user2 is not in any team
      const agents = await AgentModel.findAll(user2Id, false);
      expect(agents).toHaveLength(0);
    });

    test("findById returns agent for admin", async () => {
      const adminId = await createTestAdmin();

      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [],
      });

      const foundAgent = await AgentModel.findById(agent.id, adminId, true);
      expect(foundAgent).not.toBeNull();
      expect(foundAgent?.id).toBe(agent.id);
    });

    test("findById returns agent for user in assigned team", async () => {
      const user1Id = await createTestUser();
      const adminId = await createTestAdmin();
      const orgId = await createTestOrganization();

      const team = await TeamModel.create({
        name: "Test Team",
        organizationId: orgId,
        createdBy: adminId,
      });
      await TeamModel.addMember(team.id, user1Id);

      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [team.id],
      });

      const foundAgent = await AgentModel.findById(agent.id, user1Id, false);
      expect(foundAgent).not.toBeNull();
      expect(foundAgent?.id).toBe(agent.id);
    });

    test("findById returns null for user not in assigned teams", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();
      const adminId = await createTestAdmin();
      const orgId = await createTestOrganization();

      const team = await TeamModel.create({
        name: "Test Team",
        organizationId: orgId,
        createdBy: adminId,
      });
      await TeamModel.addMember(team.id, user1Id);

      const agent = await AgentModel.create({
        name: "Test Agent",
        teams: [team.id],
      });

      const foundAgent = await AgentModel.findById(agent.id, user2Id, false);
      expect(foundAgent).toBeNull();
    });

    test("update syncs team assignments correctly", async () => {
      const adminId = await createTestAdmin();
      const orgId = await createTestOrganization();

      const team1 = await TeamModel.create({
        name: "Team 1",
        organizationId: orgId,
        createdBy: adminId,
      });
      const team2 = await TeamModel.create({
        name: "Team 2",
        organizationId: orgId,
        createdBy: adminId,
      });

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

    test("update without teams keeps existing assignments", async () => {
      const adminId = await createTestAdmin();
      const orgId = await createTestOrganization();

      const team = await TeamModel.create({
        name: "Test Team",
        organizationId: orgId,
        createdBy: adminId,
      });

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

    test("teams is always populated in responses", async () => {
      const adminId = await createTestAdmin();
      const orgId = await createTestOrganization();

      const team = await TeamModel.create({
        name: "Test Team",
        organizationId: orgId,
        createdBy: adminId,
      });

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

      expect(agents).toHaveLength(2);

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
});
