import AgentModel from "./agent";
import AgentAccessControlModel from "./agent-access-control";

describe("AgentModel", () => {
  test("can create an agent", async () => {
    await AgentModel.create({ name: "Test Agent", usersWithAccess: [] });
    await AgentModel.create({ name: "Test Agent 2", usersWithAccess: [] });

    expect(await AgentModel.findAll()).toHaveLength(2);
  });

  describe("Access Control", () => {
    test("auto-grants creator access when agent is created", async () => {
      const creatorUserId = "user-123";
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        creatorUserId,
      );

      expect(agent.usersWithAccess).toContain(creatorUserId);

      const usersWithAccess =
        await AgentAccessControlModel.getUsersWithAccessToAgent(agent.id);
      expect(usersWithAccess).toContain(creatorUserId);
    });

    test("grants access to additional users when provided", async () => {
      const creatorUserId = "user-123";
      const additionalUserIds = ["user-456", "user-789"];

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: additionalUserIds },
        creatorUserId,
      );

      expect(agent.usersWithAccess).toContain(creatorUserId);
      expect(agent.usersWithAccess).toContain("user-456");
      expect(agent.usersWithAccess).toContain("user-789");
      expect(agent.usersWithAccess).toHaveLength(3);
    });

    test("admin can see all agents", async () => {
      await AgentModel.create(
        { name: "Agent 1", usersWithAccess: [] },
        "user-1",
      );
      await AgentModel.create(
        { name: "Agent 2", usersWithAccess: [] },
        "user-2",
      );
      await AgentModel.create(
        { name: "Agent 3", usersWithAccess: [] },
        "user-3",
      );

      const agents = await AgentModel.findAll("admin-user", true);
      expect(agents).toHaveLength(3);
    });

    test("member only sees agents they have access to", async () => {
      const agent1 = await AgentModel.create(
        { name: "Agent 1", usersWithAccess: [] },
        "user-1",
      );
      await AgentModel.create(
        { name: "Agent 2", usersWithAccess: [] },
        "user-2",
      );
      await AgentModel.create(
        { name: "Agent 3", usersWithAccess: [] },
        "user-3",
      );

      // Grant user-1 access to agent1 only (already has it as creator)
      const agents = await AgentModel.findAll("user-1", false);
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe(agent1.id);
    });

    test("member with no access sees empty list", async () => {
      await AgentModel.create(
        { name: "Agent 1", usersWithAccess: [] },
        "user-1",
      );
      await AgentModel.create(
        { name: "Agent 2", usersWithAccess: [] },
        "user-2",
      );

      const agents = await AgentModel.findAll("user-999", false);
      expect(agents).toHaveLength(0);
    });

    test("findById returns agent for admin", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        "user-1",
      );

      const foundAgent = await AgentModel.findById(
        agent.id,
        "admin-user",
        true,
      );
      expect(foundAgent).not.toBeNull();
      expect(foundAgent?.id).toBe(agent.id);
    });

    test("findById returns agent for user with access", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        "user-1",
      );

      const foundAgent = await AgentModel.findById(agent.id, "user-1", false);
      expect(foundAgent).not.toBeNull();
      expect(foundAgent?.id).toBe(agent.id);
    });

    test("findById returns null for user without access", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        "user-1",
      );

      const foundAgent = await AgentModel.findById(agent.id, "user-999", false);
      expect(foundAgent).toBeNull();
    });

    test("update syncs usersWithAccess correctly", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: ["user-2"] },
        "user-1",
      );

      expect(agent.usersWithAccess).toHaveLength(2); // user-1 (creator) + user-2

      // Update to only include user-3
      const updatedAgent = await AgentModel.update(agent.id, {
        usersWithAccess: ["user-3"],
      });

      expect(updatedAgent?.usersWithAccess).toHaveLength(1);
      expect(updatedAgent?.usersWithAccess).toContain("user-3");
      expect(updatedAgent?.usersWithAccess).not.toContain("user-1");
      expect(updatedAgent?.usersWithAccess).not.toContain("user-2");
    });

    test("update without usersWithAccess keeps existing permissions", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        "user-1",
      );

      const initialUsers = agent.usersWithAccess;

      // Update only the name
      const updatedAgent = await AgentModel.update(agent.id, {
        name: "Updated Name",
      });

      expect(updatedAgent?.name).toBe("Updated Name");
      expect(updatedAgent?.usersWithAccess).toEqual(initialUsers);
    });

    test("usersWithAccess is always populated in responses", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: ["user-2"] },
        "user-1",
      );

      expect(agent.usersWithAccess).toBeDefined();
      expect(Array.isArray(agent.usersWithAccess)).toBe(true);
      expect(agent.usersWithAccess).toHaveLength(2);

      const foundAgent = await AgentModel.findById(agent.id);
      expect(foundAgent?.usersWithAccess).toBeDefined();
      expect(Array.isArray(foundAgent?.usersWithAccess)).toBe(true);
    });
  });
});
