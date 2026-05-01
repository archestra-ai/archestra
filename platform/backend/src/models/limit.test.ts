import { describe, expect, test } from "@/test";
import AgentTeamModel from "./agent-team";
import LimitModel, { LimitValidationService } from "./limit";

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
        model: ["claude-3-5-sonnet-20241022"],
      });

      expect(limit.id).toBeDefined();
      expect(limit.entityType).toBe("agent");
      expect(limit.entityId).toBe(agent.id);
      expect(limit.limitType).toBe("token_cost");
      expect(limit.limitValue).toBe(1000000);
      expect(limit.model).toEqual(["claude-3-5-sonnet-20241022"]);
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
        model: ["gpt-4"],
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
        model: ["claude-3-5-sonnet-20241022"],
      });

      expect(limit.entityType).toBe("organization");
      expect(limit.entityId).toBe(org.id);
      expect(limit.limitValue).toBe(10000000);
    });

    test("can create a token_cost limit for a user", async ({ makeUser }) => {
      const user = await makeUser();

      const limit = await LimitModel.create({
        entityType: "user",
        entityId: user.id,
        limitType: "token_cost",
        limitValue: 500000,
        model: ["gpt-4o"],
      });

      expect(limit.entityType).toBe("user");
      expect(limit.entityId).toBe(user.id);
      expect(limit.limitValue).toBe(500000);
    });

    test("can create a token_cost limit for a virtual_key", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await makeOrganization();
      const secret = await makeSecret();
      const apiKey = await makeLlmProviderApiKey(org.id, secret.id);

      const limit = await LimitModel.create({
        entityType: "virtual_key",
        entityId: apiKey.id,
        limitType: "token_cost",
        limitValue: 250000,
        model: ["claude-3-5-sonnet-20241022"],
      });

      expect(limit.entityType).toBe("virtual_key");
      expect(limit.entityId).toBe(apiKey.id);
      expect(limit.limitValue).toBe(250000);
    });

    test("can create a token_cost limit with multiple models", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["gpt-4o", "claude-3-5-sonnet-20241022", "gemini-pro"],
      });

      expect(limit.id).toBeDefined();
      expect(limit.model).toEqual([
        "gpt-4o",
        "claude-3-5-sonnet-20241022",
        "gemini-pro",
      ]);

      // Verify model usage records were initialized for all 3 models
      const modelUsage = await LimitModel.getRawModelUsage(limit.id);

      expect(modelUsage).toHaveLength(3);
      expect(modelUsage.map((u) => u.model).sort()).toEqual([
        "claude-3-5-sonnet-20241022",
        "gemini-pro",
        "gpt-4o",
      ]);
      // All should start at 0
      for (const usage of modelUsage) {
        expect(usage.currentUsageTokensIn).toBe(0);
        expect(usage.currentUsageTokensOut).toBe(0);
      }
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
        model: ["claude-3-5-sonnet-20241022"],
      });

      await LimitModel.create({
        entityType: "agent",
        entityId: agent2.id,
        limitType: "token_cost",
        limitValue: 2000000,
        model: ["gpt-4"],
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
        model: ["claude-3-5-sonnet-20241022"],
      });

      await LimitModel.create({
        entityType: "organization",
        entityId: org.id,
        limitType: "token_cost",
        limitValue: 10000000,
        model: ["claude-3-5-sonnet-20241022"],
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
        model: ["claude-3-5-sonnet-20241022"],
      });

      await LimitModel.create({
        entityType: "agent",
        entityId: agent2.id,
        limitType: "token_cost",
        limitValue: 2000000,
        model: ["gpt-4"],
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
        model: ["claude-3-5-sonnet-20241022"],
      });

      await LimitModel.create({
        entityType: "organization",
        entityId: org.id,
        limitType: "token_cost",
        limitValue: 10000000,
        model: ["claude-3-5-sonnet-20241022"],
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
        model: ["claude-3-5-sonnet-20241022"],
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
        model: ["claude-3-5-sonnet-20241022"],
      });

      const updated = await LimitModel.patch(limit.id, {
        limitValue: 2000000,
      });

      expect(updated).toBeDefined();
      expect(updated?.limitValue).toBe(2000000);
      expect(updated?.model).toEqual(["claude-3-5-sonnet-20241022"]); // Other fields unchanged
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
        model: ["claude-3-5-sonnet-20241022"],
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
        model: ["claude-3-5-sonnet-20241022"],
      });

      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "claude-3-5-sonnet-20241022",
        100,
        200,
      );

      // Check model usage table instead
      const modelUsage = await LimitModel.getRawModelUsage(limit.id);

      expect(modelUsage.length).toBe(1);
      expect(modelUsage[0].currentUsageTokensIn).toBe(100);
      expect(modelUsage[0].currentUsageTokensOut).toBe(200);
    });

    test("should increment token usage on multiple updates", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["claude-3-5-sonnet-20241022"],
      });

      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "claude-3-5-sonnet-20241022",
        100,
        200,
      );
      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "claude-3-5-sonnet-20241022",
        50,
        75,
      );

      // Check model usage table
      const modelUsage = await LimitModel.getRawModelUsage(limit.id);

      expect(modelUsage.length).toBe(1);
      expect(modelUsage[0].currentUsageTokensIn).toBe(150);
      expect(modelUsage[0].currentUsageTokensOut).toBe(275);
    });

    test("should update only the specified model in a multi-model limit", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      // Create limit with multiple models
      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["gpt-4o", "claude-3-5-sonnet-20241022"],
      });

      // Update usage for gpt-4o only
      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "gpt-4o",
        100,
        200,
      );

      // Check that only gpt-4o was updated
      const modelUsage = await LimitModel.getRawModelUsage(limit.id);

      expect(modelUsage).toHaveLength(2);

      const claudeUsage = modelUsage.find(
        (u) => u.model === "claude-3-5-sonnet-20241022",
      );
      const gptUsage = modelUsage.find((u) => u.model === "gpt-4o");

      expect(claudeUsage?.currentUsageTokensIn).toBe(0);
      expect(claudeUsage?.currentUsageTokensOut).toBe(0);
      expect(gptUsage?.currentUsageTokensIn).toBe(100);
      expect(gptUsage?.currentUsageTokensOut).toBe(200);
    });

    test("should update multiple limits that contain the same model", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      // Create two limits, both containing gpt-4o
      const limit1 = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["gpt-4o", "claude-3-5-sonnet-20241022"],
      });

      const limit2 = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 500000,
        model: ["gpt-4o", "gemini-pro"],
      });

      // Update usage for gpt-4o
      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "gpt-4o",
        100,
        200,
      );

      // Check that gpt-4o was updated in BOTH limits
      const limit1UsageAll = await LimitModel.getRawModelUsage(limit1.id);
      const limit1Usage = limit1UsageAll.filter((u) => u.model === "gpt-4o");

      const limit2UsageAll = await LimitModel.getRawModelUsage(limit2.id);
      const limit2Usage = limit2UsageAll.filter((u) => u.model === "gpt-4o");

      expect(limit1Usage[0].currentUsageTokensIn).toBe(100);
      expect(limit1Usage[0].currentUsageTokensOut).toBe(200);
      expect(limit2Usage[0].currentUsageTokensIn).toBe(100);
      expect(limit2Usage[0].currentUsageTokensOut).toBe(200);
    });

    test("should update token usage for a user limit", async ({ makeUser }) => {
      const user = await makeUser();

      const limit = await LimitModel.create({
        entityType: "user",
        entityId: user.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["claude-3-5-sonnet-20241022"],
      });

      await LimitModel.updateTokenLimitUsage(
        "user",
        user.id,
        "claude-3-5-sonnet-20241022",
        100,
        200,
      );

      const modelUsage = await LimitModel.getRawModelUsage(limit.id);

      expect(modelUsage.length).toBe(1);
      expect(modelUsage[0].currentUsageTokensIn).toBe(100);
      expect(modelUsage[0].currentUsageTokensOut).toBe(200);
    });

    test("should update token usage for a virtual_key limit", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await makeOrganization();
      const secret = await makeSecret();
      const apiKey = await makeLlmProviderApiKey(org.id, secret.id);

      const limit = await LimitModel.create({
        entityType: "virtual_key",
        entityId: apiKey.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["gpt-4o"],
      });

      await LimitModel.updateTokenLimitUsage(
        "virtual_key",
        apiKey.id,
        "gpt-4o",
        50,
        100,
      );

      const modelUsage = await LimitModel.getRawModelUsage(limit.id);

      expect(modelUsage.length).toBe(1);
      expect(modelUsage[0].currentUsageTokensIn).toBe(50);
      expect(modelUsage[0].currentUsageTokensOut).toBe(100);
    });
  });

  describe("getModelUsageBreakdown", () => {
    test("should return empty array for limit with no usage", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["gpt-4o"],
      });

      const breakdown = await LimitModel.getModelUsageBreakdown(limit.id);

      expect(breakdown).toHaveLength(1);
      expect(breakdown[0].model).toBe("gpt-4o");
      expect(breakdown[0].tokensIn).toBe(0);
      expect(breakdown[0].tokensOut).toBe(0);
      expect(breakdown[0].cost).toBe(0);
    });

    test("should calculate cost correctly for multiple models", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["gpt-4o", "claude-3-5-sonnet-20241022"],
      });

      // Add usage for both models
      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "gpt-4o",
        100000,
        50000,
      );
      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "claude-3-5-sonnet-20241022",
        200000,
        100000,
      );

      const breakdown = await LimitModel.getModelUsageBreakdown(limit.id);

      expect(breakdown).toHaveLength(2);

      // Each model should have its own usage tracked
      const gptBreakdown = breakdown.find((b) => b.model === "gpt-4o");
      const claudeBreakdown = breakdown.find(
        (b) => b.model === "claude-3-5-sonnet-20241022",
      );

      expect(gptBreakdown?.tokensIn).toBe(100000);
      expect(gptBreakdown?.tokensOut).toBe(50000);
      // Cost depends on pricing data, just verify it's calculated
      expect(gptBreakdown?.cost).toBeGreaterThanOrEqual(0);

      expect(claudeBreakdown?.tokensIn).toBe(200000);
      expect(claudeBreakdown?.tokensOut).toBe(100000);
      expect(claudeBreakdown?.cost).toBeGreaterThanOrEqual(0);

      // Total cost should be sum of both
      const totalCost = breakdown.reduce((sum, b) => sum + b.cost, 0);
      expect(totalCost).toBeGreaterThanOrEqual(0);
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
        model: ["claude-3-5-sonnet-20241022"],
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
        model: ["claude-3-5-sonnet-20241022"],
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
        model: ["claude-3-5-sonnet-20241022"],
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
        model: ["claude-3-5-sonnet-20241022"],
      });

      // Add some usage
      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "claude-3-5-sonnet-20241022",
        100,
        200,
      );

      // Reset
      const reset = await LimitModel.resetLimitUsage(limit.id);

      // Check model usage was also reset
      const modelUsage = await LimitModel.getRawModelUsage(limit.id);

      expect(reset).toBeDefined();
      expect(modelUsage.length).toBe(1);
      expect(modelUsage[0].currentUsageTokensIn).toBe(0);
      expect(modelUsage[0].currentUsageTokensOut).toBe(0);
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
        model: ["claude-3-5-sonnet-20241022"],
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
        model: ["claude-3-5-sonnet-20241022"],
      });

      const limits = await LimitModel.findLimitsForValidation(
        "organization",
        org.id,
        "token_cost",
      );

      expect(limits).toHaveLength(0);
    });

    test("should find user limits for validation", async ({ makeUser }) => {
      const user = await makeUser();

      await LimitModel.create({
        entityType: "user",
        entityId: user.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["gpt-4o"],
      });

      const limits = await LimitModel.findLimitsForValidation(
        "user",
        user.id,
        "token_cost",
      );

      expect(limits).toHaveLength(1);
      expect(limits[0].limitType).toBe("token_cost");
    });

    test("should find virtual_key limits for validation", async ({
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const org = await makeOrganization();
      const secret = await makeSecret();
      const apiKey = await makeLlmProviderApiKey(org.id, secret.id);

      await LimitModel.create({
        entityType: "virtual_key",
        entityId: apiKey.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["gpt-4o"],
      });

      const limits = await LimitModel.findLimitsForValidation(
        "virtual_key",
        apiKey.id,
        "token_cost",
      );

      expect(limits).toHaveLength(1);
      expect(limits[0].limitType).toBe("token_cost");
    });
  });
});

describe("LimitValidationService", () => {
  describe("checkLimitsBeforeRequest", () => {
    test("should return null when no limits are set", async () => {
      const result = await LimitValidationService.checkLimitsBeforeRequest({
        agentId: "agent-123",
      });
      expect(result).toBeNull();
    });

    test("should check virtual-key limits before agent limits", async ({
      makeAgent,
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });
      const org = await makeOrganization();
      const secret = await makeSecret();
      const apiKey = await makeLlmProviderApiKey(org.id, secret.id);

      // Create a virtual key limit with very low threshold
      await LimitModel.create({
        entityType: "virtual_key",
        entityId: apiKey.id,
        limitType: "token_cost",
        limitValue: 1,
        model: ["gpt-4o"],
      });

      await LimitModel.updateTokenLimitUsage(
        "virtual_key",
        apiKey.id,
        "gpt-4o",
        1000000,
        1000000,
      );

      const result = await LimitValidationService.checkLimitsBeforeRequest({
        agentId: agent.id,
        virtualKeyId: apiKey.id,
      });

      expect(result).not.toBeNull();
      expect(result?.[1]).toContain("virtual_key-level");
    });

    test("should check user limits before agent limits", async ({
      makeAgent,
      makeUser,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });
      const user = await makeUser();

      // Create a user limit with very low threshold
      await LimitModel.create({
        entityType: "user",
        entityId: user.id,
        limitType: "token_cost",
        limitValue: 1,
        model: ["gpt-4o"],
      });

      await LimitModel.updateTokenLimitUsage(
        "user",
        user.id,
        "gpt-4o",
        1000000,
        1000000,
      );

      const result = await LimitValidationService.checkLimitsBeforeRequest({
        agentId: agent.id,
        userId: user.id,
      });

      expect(result).not.toBeNull();
      expect(result?.[1]).toContain("user-level");
    });

    test("should check agent limits before team limits", async ({
      makeAgent,
      makeOrganization,
      makeUser,
      makeTeam,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id);
      const agent = await makeAgent({ name: "Test Agent" });
      await makeMember(user.id, org.id, { role: "admin" });

      await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

      await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1,
        model: ["gpt-4o"],
      });

      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "gpt-4o",
        1000000,
        1000000,
      );

      await LimitModel.create({
        entityType: "team",
        entityId: team.id,
        limitType: "token_cost",
        limitValue: 1,
        model: ["gpt-4o"],
      });

      await LimitModel.updateTokenLimitUsage(
        "team",
        team.id,
        "gpt-4o",
        1000000,
        1000000,
      );

      const result = await LimitValidationService.checkLimitsBeforeRequest({
        agentId: agent.id,
      });

      expect(result).not.toBeNull();
      expect(result?.[1]).toContain("agent-level");
    });

    test("should check team limits before organization limits", async ({
      makeAgent,
      makeOrganization,
      makeUser,
      makeTeam,
      makeMember,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const team = await makeTeam(org.id, user.id);
      const agent = await makeAgent({ name: "Test Agent" });
      await makeMember(user.id, org.id, { role: "admin" });

      await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

      await LimitModel.create({
        entityType: "team",
        entityId: team.id,
        limitType: "token_cost",
        limitValue: 1,
        model: ["gpt-4o"],
      });

      await LimitModel.updateTokenLimitUsage(
        "team",
        team.id,
        "gpt-4o",
        1000000,
        1000000,
      );

      await LimitModel.create({
        entityType: "organization",
        entityId: org.id,
        limitType: "token_cost",
        limitValue: 1,
        model: ["gpt-4o"],
      });

      await LimitModel.updateTokenLimitUsage(
        "organization",
        org.id,
        "gpt-4o",
        1000000,
        1000000,
      );

      const result = await LimitValidationService.checkLimitsBeforeRequest({
        agentId: agent.id,
      });

      expect(result).not.toBeNull();
      expect(result?.[1]).toContain("team-level");
    });

    test("should return refusal message when limit is exceeded", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1,
        model: ["gpt-4o"],
      });

      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "gpt-4o",
        1000000,
        1000000,
      );

      const result = await LimitValidationService.checkLimitsBeforeRequest({
        agentId: agent.id,
      });

      expect(result).not.toBeNull();
      const [refusalMessage, contentMessage] = result as unknown as [
        string,
        string,
      ];

      expect(refusalMessage).toContain(
        "<archestra-limit-type>token_cost</archestra-limit-type>",
      );
      expect(refusalMessage).toContain("<archestra-limit-current-usage>");
      expect(refusalMessage).toContain("<archestra-limit-value>");

      expect(contentMessage).toContain("token cost limit");
      expect(contentMessage).toContain("Current usage:");
      expect(contentMessage).toContain("Limit:");
    });

    test("should handle errors gracefully and allow requests", async () => {
      const result = await LimitValidationService.checkLimitsBeforeRequest({
        agentId: "invalid-agent-id",
      });

      expect(result).toBeNull();
    });

    test("should handle agents with no team assignments", async () => {
      const result = await LimitValidationService.checkLimitsBeforeRequest({
        agentId: "orphan-agent-123",
      });
      expect(result).toBeNull();
    });
  });
});
