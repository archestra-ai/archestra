import { createTestAdmin, createTestUser } from "@/test-utils";
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
      const creatorUserId = await createTestUser();
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
      const creatorUserId = await createTestUser();
      const user2Id = await createTestUser();
      const user3Id = await createTestUser();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [user2Id, user3Id] },
        creatorUserId,
      );

      expect(agent.usersWithAccess).toContain(creatorUserId);
      expect(agent.usersWithAccess).toContain(user2Id);
      expect(agent.usersWithAccess).toContain(user3Id);
      expect(agent.usersWithAccess).toHaveLength(3);
    });

    test("admin can see all agents", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();
      const user3Id = await createTestUser();
      const adminId = await createTestAdmin();

      await AgentModel.create(
        { name: "Agent 1", usersWithAccess: [] },
        user1Id,
      );
      await AgentModel.create(
        { name: "Agent 2", usersWithAccess: [] },
        user2Id,
      );
      await AgentModel.create(
        { name: "Agent 3", usersWithAccess: [] },
        user3Id,
      );

      const agents = await AgentModel.findAll(adminId, true);
      expect(agents).toHaveLength(3);
    });

    test("member only sees agents they have access to", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();
      const user3Id = await createTestUser();

      const agent1 = await AgentModel.create(
        { name: "Agent 1", usersWithAccess: [] },
        user1Id,
      );
      await AgentModel.create(
        { name: "Agent 2", usersWithAccess: [] },
        user2Id,
      );
      await AgentModel.create(
        { name: "Agent 3", usersWithAccess: [] },
        user3Id,
      );

      // user-1 only has access to agent1 (as creator)
      const agents = await AgentModel.findAll(user1Id, false);
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe(agent1.id);
    });

    test("member with no access sees empty list", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();
      const user3Id = await createTestUser();

      await AgentModel.create(
        { name: "Agent 1", usersWithAccess: [] },
        user1Id,
      );
      await AgentModel.create(
        { name: "Agent 2", usersWithAccess: [] },
        user2Id,
      );

      const agents = await AgentModel.findAll(user3Id, false);
      expect(agents).toHaveLength(0);
    });

    test("findById returns agent for admin", async () => {
      const user1Id = await createTestUser();
      const adminId = await createTestAdmin();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        user1Id,
      );

      const foundAgent = await AgentModel.findById(agent.id, adminId, true);
      expect(foundAgent).not.toBeNull();
      expect(foundAgent?.id).toBe(agent.id);
    });

    test("findById returns agent for user with access", async () => {
      const user1Id = await createTestUser();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        user1Id,
      );

      const foundAgent = await AgentModel.findById(agent.id, user1Id, false);
      expect(foundAgent).not.toBeNull();
      expect(foundAgent?.id).toBe(agent.id);
    });

    test("findById returns null for user without access", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        user1Id,
      );

      const foundAgent = await AgentModel.findById(agent.id, user2Id, false);
      expect(foundAgent).toBeNull();
    });

    test("update syncs usersWithAccess correctly", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();
      const user3Id = await createTestUser();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [user2Id] },
        user1Id,
      );

      expect(agent.usersWithAccess).toHaveLength(2); // user-1 (creator) + user-2

      // Update to only include user-3
      const updatedAgent = await AgentModel.update(agent.id, {
        usersWithAccess: [user3Id],
      });

      expect(updatedAgent?.usersWithAccess).toHaveLength(1);
      expect(updatedAgent?.usersWithAccess).toContain(user3Id);
      expect(updatedAgent?.usersWithAccess).not.toContain(user1Id);
      expect(updatedAgent?.usersWithAccess).not.toContain(user2Id);
    });

    test("update without usersWithAccess keeps existing permissions", async () => {
      const user1Id = await createTestUser();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        user1Id,
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
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [user2Id] },
        user1Id,
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
