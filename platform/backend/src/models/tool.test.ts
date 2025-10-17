import AgentModel from "./agent";
import ToolModel from "./tool";

describe("ToolModel", () => {
  describe("Access Control", () => {
    test("admin can see all tools", async () => {
      const agent1 = await AgentModel.create(
        { name: "Agent 1", usersWithAccess: [] },
        "user-1",
      );
      const agent2 = await AgentModel.create(
        { name: "Agent 2", usersWithAccess: [] },
        "user-2",
      );

      await ToolModel.create({
        agentId: agent1.id,
        name: "tool1",
        description: "Tool 1",
        parameters: {},
      });

      await ToolModel.create({
        agentId: agent2.id,
        name: "tool2",
        description: "Tool 2",
        parameters: {},
      });

      const tools = await ToolModel.findAll("admin-user", true);
      expect(tools).toHaveLength(2);
    });

    test("member only sees tools for accessible agents", async () => {
      const agent1 = await AgentModel.create(
        { name: "Agent 1", usersWithAccess: [] },
        "user-1",
      );
      const agent2 = await AgentModel.create(
        { name: "Agent 2", usersWithAccess: [] },
        "user-2",
      );

      const tool1 = await ToolModel.create({
        agentId: agent1.id,
        name: "tool1",
        description: "Tool 1",
        parameters: {},
      });

      await ToolModel.create({
        agentId: agent2.id,
        name: "tool2",
        description: "Tool 2",
        parameters: {},
      });

      const tools = await ToolModel.findAll("user-1", false);
      expect(tools).toHaveLength(1);
      expect(tools[0].id).toBe(tool1.id);
    });

    test("member with no access sees no tools", async () => {
      const agent1 = await AgentModel.create(
        { name: "Agent 1", usersWithAccess: [] },
        "user-1",
      );

      await ToolModel.create({
        agentId: agent1.id,
        name: "tool1",
        description: "Tool 1",
        parameters: {},
      });

      const tools = await ToolModel.findAll("user-999", false);
      expect(tools).toHaveLength(0);
    });

    test("findById returns tool for admin", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        "user-1",
      );

      const tool = await ToolModel.create({
        agentId: agent.id,
        name: "test-tool",
        description: "Test Tool",
        parameters: {},
      });

      const found = await ToolModel.findById(tool.id, "admin-user", true);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(tool.id);
    });

    test("findById returns tool for user with agent access", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        "user-1",
      );

      const tool = await ToolModel.create({
        agentId: agent.id,
        name: "test-tool",
        description: "Test Tool",
        parameters: {},
      });

      const found = await ToolModel.findById(tool.id, "user-1", false);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(tool.id);
    });

    test("findById returns null for user without agent access", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        "user-1",
      );

      const tool = await ToolModel.create({
        agentId: agent.id,
        name: "test-tool",
        description: "Test Tool",
        parameters: {},
      });

      const found = await ToolModel.findById(tool.id, "user-999", false);
      expect(found).toBeNull();
    });

    test("findByName returns tool for admin", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        "user-1",
      );

      await ToolModel.create({
        agentId: agent.id,
        name: "unique-tool",
        description: "Unique Tool",
        parameters: {},
      });

      const found = await ToolModel.findByName("unique-tool", "admin-user", true);
      expect(found).not.toBeNull();
      expect(found?.name).toBe("unique-tool");
    });

    test("findByName returns tool for user with agent access", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        "user-1",
      );

      await ToolModel.create({
        agentId: agent.id,
        name: "user-tool",
        description: "User Tool",
        parameters: {},
      });

      const found = await ToolModel.findByName("user-tool", "user-1", false);
      expect(found).not.toBeNull();
      expect(found?.name).toBe("user-tool");
    });

    test("findByName returns null for user without agent access", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        "user-1",
      );

      await ToolModel.create({
        agentId: agent.id,
        name: "restricted-tool",
        description: "Restricted Tool",
        parameters: {},
      });

      const found = await ToolModel.findByName(
        "restricted-tool",
        "user-999",
        false,
      );
      expect(found).toBeNull();
    });
  });
});
