import { describe, expect, test } from "@/test";
import LimitModel from "./limit";

describe("LimitModel", () => {
  describe("create", () => {
    test("can create a token_cost limit for an agent", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: "claude-3-5-sonnet-20241022",
      });

      expect(limit.id).toBeDefined();
      expect(limit.entityType).toBe("agent");
      expect(limit.entityId).toBe(agent.id);
      expect(limit.limitType).toBe("token_cost");
      expect(limit.limitValue).toBe(1000000);
      expect(limit.model).toBe("claude-3-5-sonnet-20241022");
      expect(limit.currentUsageTokensIn).toBe(0);
      expect(limit.currentUsageTokensOut).toBe(0);
    });

    test("can create a token_cost limit for a team", async ({
      makeTeam,
      makeOrganization,
      makeUser,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const team = await makeTeam(org.id, user.id);

      const limit = await LimitModel.create({
        entityType: "team",
        entityId: team.id,
        limitType: "token_cost",
        limitValue: 5000000,
        model: "gpt-4",
      });

      expect(limit.entityType).toBe("team");
      expect(limit.entityId).toBe(team.id);
      expect(limit.limitValue).toBe(5000000);
    });

    test("can create a token_cost limit for an organization", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const limit = await LimitModel.create({
        entityType: "organization",
        entityId: org.id,
        limitType: "token_cost",
        limitValue: 10000000,
        model: "claude-3-5-sonnet-20241022",
      });

      expect(limit.entityType).toBe("organization");
      expect(limit.entityId).toBe(org.id);
      expect(limit.limitValue).toBe(10000000);
    });
  });

  describe("findAll", () => {
    test("can retrieve all limits", async ({ makeAgent }) => {
      const agent1 = await makeAgent({ name: "Agent 1" });
      const agent2 = await makeAgent({ name: "Agent 2" });

      await LimitModel.create({
        entityType: "agent",
        entityId: agent1.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: "claude-3-5-sonnet-20241022",
      });

      await LimitModel.create({
        entityType: "agent",
        entityId: agent2.id,
        limitType: "token_cost",
        limitValue: 2000000,
        model: "gpt-4",
      });

      const limits = await LimitModel.findAll();
      expect(limits).toHaveLength(2);
    });

    test("can filter limits by entity type", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });
      const org = await makeOrganization();

      await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: "claude-3-5-sonnet-20241022",
      });

      await LimitModel.create({
        entityType: "organization",
        entityId: org.id,
        limitType: "token_cost",
        limitValue: 10000000,
        model: "claude-3-5-sonnet-20241022",
      });

      const agentLimits = await LimitModel.findAll("agent");
      expect(agentLimits).toHaveLength(1);
      expect(agentLimits[0].entityType).toBe("agent");

      const orgLimits = await LimitModel.findAll("organization");
      expect(orgLimits).toHaveLength(1);
      expect(orgLimits[0].entityType).toBe("organization");
    });

    test("can filter limits by entity ID", async ({ makeAgent }) => {
      const agent1 = await makeAgent({ name: "Agent 1" });
      const agent2 = await makeAgent({ name: "Agent 2" });

      await LimitModel.create({
        entityType: "agent",
        entityId: agent1.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: "claude-3-5-sonnet-20241022",
      });

      await LimitModel.create({
        entityType: "agent",
        entityId: agent2.id,
        limitType: "token_cost",
        limitValue: 2000000,
        model: "gpt-4",
      });

      const agent1Limits = await LimitModel.findAll(undefined, agent1.id);
      expect(agent1Limits).toHaveLength(1);
      expect(agent1Limits[0].entityId).toBe(agent1.id);
    });

    test("can filter limits by both entity type and ID", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });
      const org = await makeOrganization();

      await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: "claude-3-5-sonnet-20241022",
      });

      await LimitModel.create({
        entityType: "organization",
        entityId: org.id,
        limitType: "token_cost",
        limitValue: 10000000,
        model: "claude-3-5-sonnet-20241022",
      });

      const agentLimits = await LimitModel.findAll("agent", agent.id);
      expect(agentLimits).toHaveLength(1);
      expect(agentLimits[0].entityType).toBe("agent");
      expect(agentLimits[0].entityId).toBe(agent.id);
    });
  });

  describe("findById", () => {
    test("can find a limit by ID", async ({ makeAgent }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const created = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: "claude-3-5-sonnet-20241022",
      });

      const found = await LimitModel.findById(created.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
      expect(found?.limitValue).toBe(1000000);
    });

    test("returns null for non-existent limit", async () => {
      const found = await LimitModel.findById(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(found).toBeNull();
    });
  });

  describe("patch", () => {
    test("can update a limit value", async ({ makeAgent }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: "claude-3-5-sonnet-20241022",
      });

      const updated = await LimitModel.patch(limit.id, {
        limitValue: 2000000,
      });

      expect(updated).toBeDefined();
      expect(updated?.limitValue).toBe(2000000);
      expect(updated?.model).toBe("claude-3-5-sonnet-20241022"); // Other fields unchanged
    });

    test("returns null for non-existent limit", async () => {
      const updated = await LimitModel.patch(
        "00000000-0000-0000-0000-000000000000",
        {
          limitValue: 2000000,
        },
      );
      expect(updated).toBeNull();
    });
  });

  describe("delete", () => {
    test("can delete a limit", async ({ makeAgent }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: "claude-3-5-sonnet-20241022",
      });

      const deleted = await LimitModel.delete(limit.id);
      expect(deleted).toBe(true);

      const found = await LimitModel.findById(limit.id);
      expect(found).toBeNull();
    });

    test("returns false for non-existent limit", async () => {
      const deleted = await LimitModel.delete(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(deleted).toBe(false);
    });
  });

  describe("getAgentTokenUsage", () => {
    test("can get token usage for an agent with no interactions", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const usage = await LimitModel.getAgentTokenUsage(agent.id);

      expect(usage.agentId).toBe(agent.id);
      expect(usage.totalInputTokens).toBe(0);
      expect(usage.totalOutputTokens).toBe(0);
      expect(usage.totalTokens).toBe(0);
    });

    test("can get token usage for an agent with interactions", async ({
      makeAgent,
      makeInteraction,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      await makeInteraction(agent.id, {
        inputTokens: 100,
        outputTokens: 200,
      });

      await makeInteraction(agent.id, {
        inputTokens: 150,
        outputTokens: 250,
      });

      const usage = await LimitModel.getAgentTokenUsage(agent.id);

      expect(usage.agentId).toBe(agent.id);
      expect(usage.totalInputTokens).toBe(250);
      expect(usage.totalOutputTokens).toBe(450);
      expect(usage.totalTokens).toBe(700);
    });

    test("returns zero usage for non-existent agent", async () => {
      const usage = await LimitModel.getAgentTokenUsage(
        "00000000-0000-0000-0000-000000000000",
      );

      expect(usage.totalInputTokens).toBe(0);
      expect(usage.totalOutputTokens).toBe(0);
      expect(usage.totalTokens).toBe(0);
    });
  });

  describe("updateTokenLimitUsage", () => {
    test("should update token usage for a limit", async ({ makeAgent }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: "claude-3-5-sonnet-20241022",
      });

      await LimitModel.updateTokenLimitUsage("agent", agent.id, 100, 200);

      const updated = await LimitModel.findById(limit.id);
      expect(updated?.currentUsageTokensIn).toBe(100);
      expect(updated?.currentUsageTokensOut).toBe(200);
    });

    test("should increment token usage on multiple updates", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: "claude-3-5-sonnet-20241022",
      });

      await LimitModel.updateTokenLimitUsage("agent", agent.id, 100, 200);
      await LimitModel.updateTokenLimitUsage("agent", agent.id, 50, 75);

      const limits = await LimitModel.findAll("agent", agent.id);
      expect(limits[0].currentUsageTokensIn).toBe(150);
      expect(limits[0].currentUsageTokensOut).toBe(275);
    });
  });

  describe("findLimitsNeedingCleanup", () => {
    test("should find limits that have never been cleaned up", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      await LimitModel.create({
        entityType: "organization",
        entityId: org.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: "claude-3-5-sonnet-20241022",
      });

      const cutoffTime = new Date();
      const limits = await LimitModel.findLimitsNeedingCleanup(
        org.id,
        cutoffTime,
      );

      expect(limits).toHaveLength(1);
      expect(limits[0].lastCleanup).toBeNull();
    });

    test("should find limits with old lastCleanup", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const limit = await LimitModel.create({
        entityType: "organization",
        entityId: org.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: "claude-3-5-sonnet-20241022",
      });

      // Set lastCleanup to 2 hours ago
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await LimitModel.patch(limit.id, { lastCleanup: twoHoursAgo });

      // Check with cutoff of 1 hour ago
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const limits = await LimitModel.findLimitsNeedingCleanup(
        org.id,
        oneHourAgo,
      );

      expect(limits).toHaveLength(1);
    });

    test("should not find limits with recent lastCleanup", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const limit = await LimitModel.create({
        entityType: "organization",
        entityId: org.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: "claude-3-5-sonnet-20241022",
      });

      // Set lastCleanup to 30 minutes ago
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
      await LimitModel.patch(limit.id, { lastCleanup: thirtyMinutesAgo });

      // Check with cutoff of 1 hour ago
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const limits = await LimitModel.findLimitsNeedingCleanup(
        org.id,
        oneHourAgo,
      );

      expect(limits).toHaveLength(0);
    });
  });

  describe("resetLimitUsage", () => {
    test("should reset usage counters and set lastCleanup", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: "claude-3-5-sonnet-20241022",
      });

      // Add some usage
      await LimitModel.updateTokenLimitUsage("agent", agent.id, 100, 200);

      // Reset
      const reset = await LimitModel.resetLimitUsage(limit.id);

      expect(reset).toBeDefined();
      expect(reset?.currentUsageTokensIn).toBe(0);
      expect(reset?.currentUsageTokensOut).toBe(0);
      expect(reset?.lastCleanup).toBeDefined();
      expect(reset?.lastCleanup).not.toBeNull();
    });
  });

  describe("findLimitsForValidation", () => {
    test("should find limits for validation", async ({ makeAgent }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: "claude-3-5-sonnet-20241022",
      });

      const limits = await LimitModel.findLimitsForValidation(
        "agent",
        agent.id,
        "token_cost",
      );

      expect(limits).toHaveLength(1);
      expect(limits[0].limitType).toBe("token_cost");
    });

    test("should not find limits for other entity types", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });
      const org = await makeOrganization();

      await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: "claude-3-5-sonnet-20241022",
      });

      const limits = await LimitModel.findLimitsForValidation(
        "organization",
        org.id,
        "token_cost",
      );

      expect(limits).toHaveLength(0);
    });
  });
});
