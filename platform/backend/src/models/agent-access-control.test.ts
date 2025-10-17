import AgentAccessControlModel from "./agent-access-control";
import AgentModel from "./agent";

describe("AgentAccessControlModel", () => {
  describe("grantAgentAccess", () => {
    test("grants access to multiple users", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        "creator-user",
      );

      await AgentAccessControlModel.grantAgentAccess(agent.id, [
        "user-1",
        "user-2",
        "user-3",
      ]);

      const usersWithAccess =
        await AgentAccessControlModel.getUsersWithAccessToAgent(agent.id);
      expect(usersWithAccess).toContain("creator-user");
      expect(usersWithAccess).toContain("user-1");
      expect(usersWithAccess).toContain("user-2");
      expect(usersWithAccess).toContain("user-3");
      expect(usersWithAccess).toHaveLength(4);
    });

    test("is idempotent (duplicate grants do not fail)", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        "user-1",
      );

      await AgentAccessControlModel.grantAgentAccess(agent.id, ["user-2"]);
      await AgentAccessControlModel.grantAgentAccess(agent.id, ["user-2"]); // Duplicate

      const usersWithAccess =
        await AgentAccessControlModel.getUsersWithAccessToAgent(agent.id);
      expect(usersWithAccess).toContain("user-1");
      expect(usersWithAccess).toContain("user-2");
      expect(usersWithAccess).toHaveLength(2); // No duplicates
    });

    test("handles empty user array gracefully", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        "user-1",
      );

      await AgentAccessControlModel.grantAgentAccess(agent.id, []);

      const usersWithAccess =
        await AgentAccessControlModel.getUsersWithAccessToAgent(agent.id);
      expect(usersWithAccess).toHaveLength(1); // Only creator
    });
  });

  describe("syncAgentAccess", () => {
    test("replaces all existing access with new list", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: ["user-2", "user-3"] },
        "user-1",
      );

      expect(
        await AgentAccessControlModel.getUsersWithAccessToAgent(agent.id),
      ).toHaveLength(3);

      // Sync to only user-4 and user-5
      await AgentAccessControlModel.syncAgentAccess(agent.id, [
        "user-4",
        "user-5",
      ]);

      const usersWithAccess =
        await AgentAccessControlModel.getUsersWithAccessToAgent(agent.id);
      expect(usersWithAccess).toContain("user-4");
      expect(usersWithAccess).toContain("user-5");
      expect(usersWithAccess).not.toContain("user-1"); // Creator removed
      expect(usersWithAccess).not.toContain("user-2");
      expect(usersWithAccess).not.toContain("user-3");
      expect(usersWithAccess).toHaveLength(2);
    });

    test("can remove all access by syncing with empty array", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: ["user-2"] },
        "user-1",
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
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        "user-1",
      );

      const count = await AgentAccessControlModel.syncAgentAccess(agent.id, [
        "user-2",
        "user-3",
        "user-4",
      ]);
      expect(count).toBe(3);
    });
  });

  describe("getUserAccessibleAgentIds", () => {
    test("returns all agent IDs user has access to", async () => {
      const agent1 = await AgentModel.create(
        { name: "Agent 1", usersWithAccess: [] },
        "user-1",
      );
      const agent2 = await AgentModel.create(
        { name: "Agent 2", usersWithAccess: [] },
        "user-1",
      );
      const agent3 = await AgentModel.create(
        { name: "Agent 3", usersWithAccess: [] },
        "user-2",
      );

      const accessibleAgents =
        await AgentAccessControlModel.getUserAccessibleAgentIds("user-1");
      expect(accessibleAgents).toContain(agent1.id);
      expect(accessibleAgents).toContain(agent2.id);
      expect(accessibleAgents).not.toContain(agent3.id);
      expect(accessibleAgents).toHaveLength(2);
    });

    test("returns empty array for user with no access", async () => {
      await AgentModel.create(
        { name: "Agent 1", usersWithAccess: [] },
        "user-1",
      );

      const accessibleAgents =
        await AgentAccessControlModel.getUserAccessibleAgentIds("user-999");
      expect(accessibleAgents).toHaveLength(0);
    });
  });

  describe("userHasAgentAccess", () => {
    test("returns true for admin regardless of access grants", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        "user-1",
      );

      const hasAccess = await AgentAccessControlModel.userHasAgentAccess(
        "admin-user",
        agent.id,
        true,
      );
      expect(hasAccess).toBe(true);
    });

    test("returns true for user with granted access", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        "user-1",
      );

      const hasAccess = await AgentAccessControlModel.userHasAgentAccess(
        "user-1",
        agent.id,
        false,
      );
      expect(hasAccess).toBe(true);
    });

    test("returns false for user without access", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
        "user-1",
      );

      const hasAccess = await AgentAccessControlModel.userHasAgentAccess(
        "user-999",
        agent.id,
        false,
      );
      expect(hasAccess).toBe(false);
    });
  });

  describe("getUsersWithAccessToAgent", () => {
    test("returns all users with access to an agent", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: ["user-2", "user-3"] },
        "user-1",
      );

      const usersWithAccess =
        await AgentAccessControlModel.getUsersWithAccessToAgent(agent.id);
      expect(usersWithAccess).toContain("user-1");
      expect(usersWithAccess).toContain("user-2");
      expect(usersWithAccess).toContain("user-3");
      expect(usersWithAccess).toHaveLength(3);
    });

    test("returns empty array for agent with no granted access", async () => {
      const agent = await AgentModel.create(
        { name: "Test Agent", usersWithAccess: [] },
      );

      const usersWithAccess =
        await AgentAccessControlModel.getUsersWithAccessToAgent(agent.id);
      expect(usersWithAccess).toHaveLength(0);
    });
  });
});
