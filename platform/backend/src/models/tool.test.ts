import { createTestAdmin, createTestUser } from "@/test-utils";
import AgentModel from "./agent";
import ToolModel from "./tool";

describe("ToolModel", () => {
  describe("Access Control", () => {
    test("admin can see all tools", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();
      const adminId = await createTestAdmin();

      const agent1 = await AgentModel.create(
        { name: "Agent 1", usersWithAccess: [] },
        user1Id,
      );
      const agent2 = await AgentModel.create(
        { name: "Agent 2", usersWithAccess: [] },
        user2Id,
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

      const tools = await ToolModel.findAll(adminId, true);
      expect(tools).toHaveLength(2);
    });

    test("member only sees tools for accessible agents", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();

      const agent1 = await AgentModel.create(
        { name: "Agent 1", usersWithAccess: [] },
        user1Id,
      );
      const agent2 = await AgentModel.create(
        { name: "Agent 2", usersWithAccess: [] },
        user2Id,
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

      const tools = await ToolModel.findAll(user1Id, false);
      expect(tools).toHaveLength(1);
      expect(tools[0].id).toBe(tool1.id);
    });

    test("member with no access sees no tools", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();

      const agent1 = await AgentModel.create(
        { name: "Agent 1", usersWithAccess: [] },
        user1Id,
      );

      await ToolModel.create({
        agentId: agent1.id,
        name: "tool1",
        description: "Tool 1",
        parameters: {},
      });

      const tools = await ToolModel.findAll(user2Id, false);
      expect(tools).toHaveLength(0);
    });

    test("findById returns tool for admin", async () => {
      const user1Id = await createTestUser();
      const adminId = await createTestAdmin();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        user1Id,
      );

      const tool = await ToolModel.create({
        agentId: agent.id,
        name: "test-tool",
        description: "Test Tool",
        parameters: {},
      });

      const found = await ToolModel.findById(tool.id, adminId, true);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(tool.id);
    });

    test("findById returns tool for user with agent access", async () => {
      const user1Id = await createTestUser();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        user1Id,
      );

      const tool = await ToolModel.create({
        agentId: agent.id,
        name: "test-tool",
        description: "Test Tool",
        parameters: {},
      });

      const found = await ToolModel.findById(tool.id, user1Id, false);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(tool.id);
    });

    test("findById returns null for user without agent access", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        user1Id,
      );

      const tool = await ToolModel.create({
        agentId: agent.id,
        name: "test-tool",
        description: "Test Tool",
        parameters: {},
      });

      const found = await ToolModel.findById(tool.id, user2Id, false);
      expect(found).toBeNull();
    });

    test("findByName returns tool for admin", async () => {
      const user1Id = await createTestUser();
      const adminId = await createTestAdmin();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        user1Id,
      );

      await ToolModel.create({
        agentId: agent.id,
        name: "unique-tool",
        description: "Unique Tool",
        parameters: {},
      });

      const found = await ToolModel.findByName("unique-tool", adminId, true);
      expect(found).not.toBeNull();
      expect(found?.name).toBe("unique-tool");
    });

    test("findByName returns tool for user with agent access", async () => {
      const user1Id = await createTestUser();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        user1Id,
      );

      await ToolModel.create({
        agentId: agent.id,
        name: "user-tool",
        description: "User Tool",
        parameters: {},
      });

      const found = await ToolModel.findByName("user-tool", user1Id, false);
      expect(found).not.toBeNull();
      expect(found?.name).toBe("user-tool");
    });

    test("findByName returns null for user without agent access", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        user1Id,
      );

      await ToolModel.create({
        agentId: agent.id,
        name: "restricted-tool",
        description: "Restricted Tool",
        parameters: {},
      });

      const found = await ToolModel.findByName(
        "restricted-tool",
        user2Id,
        false,
      );
      expect(found).toBeNull();
    });
  });
});
