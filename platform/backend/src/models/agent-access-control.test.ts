import { createTestUser } from "@/test-utils";
import AgentModel from "./agent";
import AgentAccessControlModel from "./agent-access-control";

describe("AgentAccessControlModel", () => {
  describe("grantAgentAccess", () => {
    test("grants access to multiple users", async () => {
      // Create test users first
      const creatorUserId = await createTestUser();
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();
      const user3Id = await createTestUser();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        creatorUserId,
      );

      await AgentAccessControlModel.grantAgentAccess(agent.id, [
        user1Id,
        user2Id,
        user3Id,
      ]);

      const usersWithAccess =
        await AgentAccessControlModel.getUsersWithAccessToAgent(agent.id);
      expect(usersWithAccess).toContain(creatorUserId);
      expect(usersWithAccess).toContain(user1Id);
      expect(usersWithAccess).toContain(user2Id);
      expect(usersWithAccess).toContain(user3Id);
      expect(usersWithAccess).toHaveLength(4);
    });

    test("is idempotent (duplicate grants do not fail)", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        user1Id,
      );

      await AgentAccessControlModel.grantAgentAccess(agent.id, [user2Id]);
      await AgentAccessControlModel.grantAgentAccess(agent.id, [user2Id]); // Duplicate

      const usersWithAccess =
        await AgentAccessControlModel.getUsersWithAccessToAgent(agent.id);
      expect(usersWithAccess).toContain(user1Id);
      expect(usersWithAccess).toContain(user2Id);
      expect(usersWithAccess).toHaveLength(2); // No duplicates
    });

    test("handles empty user array gracefully", async () => {
      const user1Id = await createTestUser();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        user1Id,
      );

      await AgentAccessControlModel.grantAgentAccess(agent.id, []);

      const usersWithAccess =
        await AgentAccessControlModel.getUsersWithAccessToAgent(agent.id);
      expect(usersWithAccess).toHaveLength(1); // Only creator
    });
  });

  describe("syncAgentAccess", () => {
    test("replaces all existing access with new list", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();
      const user3Id = await createTestUser();
      const user4Id = await createTestUser();
      const user5Id = await createTestUser();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [user2Id, user3Id] },
        user1Id,
      );

      expect(
        await AgentAccessControlModel.getUsersWithAccessToAgent(agent.id),
      ).toHaveLength(3);

      // Sync to only user-4 and user-5
      await AgentAccessControlModel.syncAgentAccess(agent.id, [
        user4Id,
        user5Id,
      ]);

      const usersWithAccess =
        await AgentAccessControlModel.getUsersWithAccessToAgent(agent.id);
      expect(usersWithAccess).toContain(user4Id);
      expect(usersWithAccess).toContain(user5Id);
      expect(usersWithAccess).not.toContain(user1Id); // Creator removed
      expect(usersWithAccess).not.toContain(user2Id);
      expect(usersWithAccess).not.toContain(user3Id);
      expect(usersWithAccess).toHaveLength(2);
    });

    test("can remove all access by syncing with empty array", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [user2Id] },
        user1Id,
      );

      expect(
        await AgentAccessControlModel.getUsersWithAccessToAgent(agent.id),
      ).toHaveLength(2);

      await AgentAccessControlModel.syncAgentAccess(agent.id, []);

      const usersWithAccess =
        await AgentAccessControlModel.getUsersWithAccessToAgent(agent.id);
      expect(usersWithAccess).toHaveLength(0);
    });

    test("returns count of synced users", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();
      const user3Id = await createTestUser();
      const user4Id = await createTestUser();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        user1Id,
      );

      const count = await AgentAccessControlModel.syncAgentAccess(agent.id, [
        user2Id,
        user3Id,
        user4Id,
      ]);
      expect(count).toBe(3);
    });
  });

  describe("getUserAccessibleAgentIds", () => {
    test("returns all agent IDs user has access to", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();

      const agent1 = await AgentModel.create(
        { name: "Agent 1", usersWithAccess: [] },
        user1Id,
      );
      const agent2 = await AgentModel.create(
        { name: "Agent 2", usersWithAccess: [] },
        user1Id,
      );
      const agent3 = await AgentModel.create(
        { name: "Agent 3", usersWithAccess: [] },
        user2Id,
      );

      const accessibleAgents =
        await AgentAccessControlModel.getUserAccessibleAgentIds(user1Id);
      expect(accessibleAgents).toContain(agent1.id);
      expect(accessibleAgents).toContain(agent2.id);
      expect(accessibleAgents).not.toContain(agent3.id);
      expect(accessibleAgents).toHaveLength(2);
    });

    test("returns empty array for user with no access", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();

      await AgentModel.create(
        { name: "Agent 1", usersWithAccess: [] },
        user1Id,
      );

      const accessibleAgents =
        await AgentAccessControlModel.getUserAccessibleAgentIds(user2Id);
      expect(accessibleAgents).toHaveLength(0);
    });
  });

  describe("userHasAgentAccess", () => {
    test("returns true for admin regardless of access grants", async () => {
      const user1Id = await createTestUser();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        user1Id,
      );

      const hasAccess = await AgentAccessControlModel.userHasAgentAccess(
        "any-admin-id",
        agent.id,
        true,
      );
      expect(hasAccess).toBe(true);
    });

    test("returns true for user with granted access", async () => {
      const user1Id = await createTestUser();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        user1Id,
      );

      const hasAccess = await AgentAccessControlModel.userHasAgentAccess(
        user1Id,
        agent.id,
        false,
      );
      expect(hasAccess).toBe(true);
    });

    test("returns false for user without access", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        user1Id,
      );

      const hasAccess = await AgentAccessControlModel.userHasAgentAccess(
        user2Id,
        agent.id,
        false,
      );
      expect(hasAccess).toBe(false);
    });
  });

  describe("getUsersWithAccessToAgent", () => {
    test("returns all users with access to an agent", async () => {
      const user1Id = await createTestUser();
      const user2Id = await createTestUser();
      const user3Id = await createTestUser();

      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [user2Id, user3Id] },
        user1Id,
      );

      const usersWithAccess =
        await AgentAccessControlModel.getUsersWithAccessToAgent(agent.id);
      expect(usersWithAccess).toContain(user1Id);
      expect(usersWithAccess).toContain(user2Id);
      expect(usersWithAccess).toContain(user3Id);
      expect(usersWithAccess).toHaveLength(3);
    });

    test("returns empty array for agent with no granted access", async () => {
      const agent = await AgentModel.create({
        name: "Test Agent",
        usersWithAccess: [],
      });

      const usersWithAccess =
        await AgentAccessControlModel.getUsersWithAccessToAgent(agent.id);
      expect(usersWithAccess).toHaveLength(0);
    });
  });
});
