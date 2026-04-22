import { ALL_MODELS_SENTINEL } from "@shared";
import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import LimitModel, { LimitValidationService } from "./limit";
import VirtualApiKeyModel from "./virtual-api-key";

describe("LimitModel", () => {
  describe("create", () => {
    test("can create a token_cost limit for an agent", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        organizationId: agent.organizationId,
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
        organizationId: org.id,
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
        organizationId: org.id,
        limitType: "token_cost",
        limitValue: 10000000,
        model: ["claude-3-5-sonnet-20241022"],
      });

      expect(limit.entityType).toBe("organization");
      expect(limit.entityId).toBe(org.id);
      expect(limit.limitValue).toBe(10000000);
    });

    test("can create a token_cost limit with multiple models", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        organizationId: agent.organizationId,
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
    test("can retrieve all limits for an org", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const agent1 = await makeAgent({
        name: "Agent 1",
        organizationId: org.id,
      });
      const agent2 = await makeAgent({
        name: "Agent 2",
        organizationId: org.id,
      });

      await LimitModel.create({
        entityType: "agent",
        entityId: agent1.id,
        organizationId: org.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["claude-3-5-sonnet-20241022"],
      });

      await LimitModel.create({
        entityType: "agent",
        entityId: agent2.id,
        organizationId: org.id,
        limitType: "token_cost",
        limitValue: 2000000,
        model: ["gpt-4"],
      });

      const limits = await LimitModel.findAll({ organizationId: org.id });
      expect(limits).toHaveLength(2);
    });

    test("findAll does not leak limits from other orgs", async ({
      makeOrganization,
    }) => {
      const orgA = await makeOrganization();
      const orgB = await makeOrganization();
      await LimitModel.create({
        entityType: "organization",
        entityId: orgA.id,
        organizationId: orgA.id,
        limitType: "token_cost",
        limitValue: 1,
        model: ["gpt-4o"],
      });
      await LimitModel.create({
        entityType: "organization",
        entityId: orgB.id,
        organizationId: orgB.id,
        limitType: "token_cost",
        limitValue: 2,
        model: ["gpt-4o"],
      });

      const aLimits = await LimitModel.findAll({ organizationId: orgA.id });
      expect(aLimits).toHaveLength(1);
      expect(aLimits[0].organizationId).toBe(orgA.id);
    });

    test("can filter limits by entity type", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({
        name: "Test Agent",
        organizationId: org.id,
      });

      await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        organizationId: org.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["claude-3-5-sonnet-20241022"],
      });

      await LimitModel.create({
        entityType: "organization",
        entityId: org.id,
        organizationId: org.id,
        limitType: "token_cost",
        limitValue: 10000000,
        model: ["claude-3-5-sonnet-20241022"],
      });

      const agentLimits = await LimitModel.findAll({
        organizationId: org.id,
        entityType: "agent",
      });
      expect(agentLimits).toHaveLength(1);
      expect(agentLimits[0].entityType).toBe("agent");

      const orgLimits = await LimitModel.findAll({
        organizationId: org.id,
        entityType: "organization",
      });
      expect(orgLimits).toHaveLength(1);
      expect(orgLimits[0].entityType).toBe("organization");
    });

    test("can filter limits by entity ID", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const agent1 = await makeAgent({
        name: "Agent 1",
        organizationId: org.id,
      });
      const agent2 = await makeAgent({
        name: "Agent 2",
        organizationId: org.id,
      });

      await LimitModel.create({
        entityType: "agent",
        entityId: agent1.id,
        organizationId: org.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["claude-3-5-sonnet-20241022"],
      });

      await LimitModel.create({
        entityType: "agent",
        entityId: agent2.id,
        organizationId: org.id,
        limitType: "token_cost",
        limitValue: 2000000,
        model: ["gpt-4"],
      });

      const agent1Limits = await LimitModel.findAll({
        organizationId: org.id,
        entityId: agent1.id,
      });
      expect(agent1Limits).toHaveLength(1);
      expect(agent1Limits[0].entityId).toBe(agent1.id);
    });

    test("can filter limits by both entity type and ID", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const org = await makeOrganization();
      const agent = await makeAgent({
        name: "Test Agent",
        organizationId: org.id,
      });

      await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        organizationId: org.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["claude-3-5-sonnet-20241022"],
      });

      await LimitModel.create({
        entityType: "organization",
        entityId: org.id,
        organizationId: org.id,
        limitType: "token_cost",
        limitValue: 10000000,
        model: ["claude-3-5-sonnet-20241022"],
      });

      const agentLimits = await LimitModel.findAll({
        organizationId: org.id,
        entityType: "agent",
        entityId: agent.id,
      });
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
        organizationId: agent.organizationId,
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
        organizationId: agent.organizationId,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["claude-3-5-sonnet-20241022"],
      });

      const updated = await LimitModel.patch({
        id: limit.id,
        data: { limitValue: 2000000 },
      });

      expect(updated).toBeDefined();
      expect(updated?.limitValue).toBe(2000000);
      expect(updated?.model).toEqual(["claude-3-5-sonnet-20241022"]); // Other fields unchanged
    });

    test("returns null for non-existent limit", async () => {
      const updated = await LimitModel.patch({
        id: "00000000-0000-0000-0000-000000000000",
        data: { limitValue: 2000000 },
      });
      expect(updated).toBeNull();
    });
  });

  describe("delete", () => {
    test("can delete a limit", async ({ makeAgent }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        organizationId: agent.organizationId,
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

  describe("deleteByEntity", () => {
    test("removes only limits for the given entity type + id", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const [targetLimit] = await db
        .insert(schema.limitsTable)
        .values({
          entityType: "user",
          entityId: "alice",
          organizationId: org.id,
          limitType: "token_cost",
          limitValue: 100,
          model: ["gpt-4o"],
        })
        .returning();

      const [otherUserLimit] = await db
        .insert(schema.limitsTable)
        .values({
          entityType: "user",
          entityId: "bob",
          organizationId: org.id,
          limitType: "token_cost",
          limitValue: 100,
          model: ["gpt-4o"],
        })
        .returning();

      const [vkeyLimit] = await db
        .insert(schema.limitsTable)
        .values({
          entityType: "virtual_api_key",
          entityId: "vkey-1",
          organizationId: org.id,
          limitType: "token_cost",
          limitValue: 100,
          model: ["gpt-4o"],
        })
        .returning();

      const removed = await LimitModel.deleteByEntity("user", "alice");
      expect(removed).toBe(1);

      const surviving = await db
        .select({ id: schema.limitsTable.id })
        .from(schema.limitsTable)
        .where(eq(schema.limitsTable.organizationId, org.id));
      const survivingIds = surviving.map((r) => r.id).sort();
      expect(survivingIds).toEqual([otherUserLimit.id, vkeyLimit.id].sort());
      expect(survivingIds).not.toContain(targetLimit.id);
    });

    test("returns 0 when no limits match", async () => {
      const removed = await LimitModel.deleteByEntity(
        "user",
        "never-had-a-limit",
      );
      expect(removed).toBe(0);
    });
  });

  describe("orphan cleanup on deletion", () => {
    test("VirtualApiKeyModel.delete removes vkey-scope limits", async ({
      makeOrganization,
      makeLlmProviderApiKey,
      makeSecret,
      makeUser,
    }) => {
      const org = await makeOrganization();
      const user = await makeUser();
      const secret = await makeSecret();
      const chatApiKey = await makeLlmProviderApiKey(org.id, secret.id);

      const { virtualKey } = await VirtualApiKeyModel.create({
        chatApiKeyId: chatApiKey.id,
        name: "test-vkey",
        authorId: user.id,
        scope: "personal",
      });

      await db.insert(schema.limitsTable).values({
        entityType: "virtual_api_key",
        entityId: virtualKey.id,
        organizationId: org.id,
        limitType: "token_cost",
        limitValue: 100,
        model: ["gpt-4o"],
      });

      await VirtualApiKeyModel.delete(virtualKey.id);

      const remaining = await db
        .select({ id: schema.limitsTable.id })
        .from(schema.limitsTable)
        .where(
          and(
            eq(schema.limitsTable.entityType, "virtual_api_key"),
            eq(schema.limitsTable.entityId, virtualKey.id),
          ),
        );
      expect(remaining).toHaveLength(0);
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
        organizationId: agent.organizationId,
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
        agent.organizationId,
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
        organizationId: agent.organizationId,
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
        agent.organizationId,
      );
      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "claude-3-5-sonnet-20241022",
        50,
        75,
        agent.organizationId,
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
        organizationId: agent.organizationId,
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
        agent.organizationId,
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
        organizationId: agent.organizationId,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["gpt-4o", "claude-3-5-sonnet-20241022"],
      });

      const limit2 = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        organizationId: agent.organizationId,
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
        agent.organizationId,
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
  });

  describe("getModelUsageBreakdown", () => {
    test("should return empty array for limit with no usage", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        organizationId: agent.organizationId,
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
        organizationId: agent.organizationId,
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
        agent.organizationId,
      );
      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "claude-3-5-sonnet-20241022",
        200000,
        100000,
        agent.organizationId,
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
        organizationId: org.id,
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
        organizationId: org.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["claude-3-5-sonnet-20241022"],
      });

      // Set lastCleanup to 2 hours ago
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await LimitModel.patch({
        id: limit.id,
        data: { lastCleanup: twoHoursAgo },
      });

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
        organizationId: org.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["claude-3-5-sonnet-20241022"],
      });

      // Set lastCleanup to 30 minutes ago
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
      await LimitModel.patch({
        id: limit.id,
        data: { lastCleanup: thirtyMinutesAgo },
      });

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
        organizationId: agent.organizationId,
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
        agent.organizationId,
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
        organizationId: agent.organizationId,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["claude-3-5-sonnet-20241022"],
      });

      const limits = await LimitModel.findLimitsForValidation(
        "agent",
        agent.id,
        agent.organizationId,
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
        organizationId: agent.organizationId,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["claude-3-5-sonnet-20241022"],
      });

      const limits = await LimitModel.findLimitsForValidation(
        "organization",
        org.id,
        org.id,
        "token_cost",
      );

      expect(limits).toHaveLength(0);
    });
  });
});

describe("LimitModel with ALL_MODELS_SENTINEL", () => {
  test("create with ['*'] does NOT pre-seed usage rows", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const limit = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      organizationId: org.id,
      limitType: "token_cost",
      limitValue: 1000,
      model: [ALL_MODELS_SENTINEL],
    });

    const usage = await LimitModel.getRawModelUsage(limit.id);
    expect(usage).toHaveLength(0);
  });

  test("updateTokenLimitUsage writes through an ['*'] limit (lazy row)", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const limit = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      organizationId: org.id,
      limitType: "token_cost",
      limitValue: 1000,
      model: [ALL_MODELS_SENTINEL],
    });

    await LimitModel.updateTokenLimitUsage(
      "organization",
      org.id,
      "gpt-4o",
      100,
      200,
      org.id,
    );
    await LimitModel.updateTokenLimitUsage(
      "organization",
      org.id,
      "claude-3-opus",
      50,
      75,
      org.id,
    );

    const usage = await LimitModel.getRawModelUsage(limit.id);
    expect(usage).toHaveLength(2);
    const byModel = Object.fromEntries(usage.map((u) => [u.model, u]));
    expect(byModel["gpt-4o"].currentUsageTokensIn).toBe(100);
    expect(byModel["gpt-4o"].currentUsageTokensOut).toBe(200);
    expect(byModel["claude-3-opus"].currentUsageTokensIn).toBe(50);
    expect(byModel["claude-3-opus"].currentUsageTokensOut).toBe(75);
  });

  test("updateTokenLimitUsage accumulates on BOTH concrete and sentinel limits", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const concrete = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      organizationId: org.id,
      limitType: "token_cost",
      limitValue: 1000,
      model: ["gpt-4o"],
    });
    const sentinel = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      organizationId: org.id,
      limitType: "token_cost",
      limitValue: 5000,
      model: [ALL_MODELS_SENTINEL],
    });

    await LimitModel.updateTokenLimitUsage(
      "organization",
      org.id,
      "gpt-4o",
      100,
      50,
      org.id,
    );

    const concreteUsage = await LimitModel.getRawModelUsage(concrete.id);
    const sentinelUsage = await LimitModel.getRawModelUsage(sentinel.id);
    expect(concreteUsage[0].currentUsageTokensIn).toBe(100);
    expect(concreteUsage[0].currentUsageTokensOut).toBe(50);
    expect(sentinelUsage[0].currentUsageTokensIn).toBe(100);
    expect(sentinelUsage[0].currentUsageTokensOut).toBe(50);
  });
});

describe("findLimitsNeedingCleanup — single-table over organization_id", () => {
  test("covers every entity type scoped to the same org", async ({
    makeOrganization,
    makeUser,
    makeTeam,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({ organizationId: org.id });

    // One limit per entity type, all under the same org.
    await db.insert(schema.limitsTable).values([
      {
        entityType: "organization",
        entityId: org.id,
        organizationId: org.id,
        limitType: "token_cost",
        limitValue: 100,
        model: ["gpt-4o"],
      },
      {
        entityType: "team",
        entityId: team.id,
        organizationId: org.id,
        limitType: "token_cost",
        limitValue: 100,
        model: ["gpt-4o"],
      },
      {
        entityType: "agent",
        entityId: agent.id,
        organizationId: org.id,
        limitType: "token_cost",
        limitValue: 100,
        model: ["gpt-4o"],
      },
      {
        entityType: "user",
        entityId: user.id,
        organizationId: org.id,
        limitType: "token_cost",
        limitValue: 100,
        model: ["gpt-4o"],
      },
      {
        entityType: "virtual_api_key",
        entityId: "vkey-abc",
        organizationId: org.id,
        limitType: "token_cost",
        limitValue: 100,
        model: ["gpt-4o"],
      },
    ]);

    const found = await LimitModel.findLimitsNeedingCleanup(org.id, new Date());
    const types = found.map((l) => l.entityType).sort();
    expect(types).toEqual(
      ["agent", "organization", "team", "user", "virtual_api_key"].sort(),
    );
  });

  test("does not return limits belonging to another organization", async ({
    makeOrganization,
  }) => {
    const orgA = await makeOrganization();
    const orgB = await makeOrganization();

    await db.insert(schema.limitsTable).values([
      {
        entityType: "organization",
        entityId: orgA.id,
        organizationId: orgA.id,
        limitType: "token_cost",
        limitValue: 100,
        model: ["gpt-4o"],
      },
      {
        entityType: "organization",
        entityId: orgB.id,
        organizationId: orgB.id,
        limitType: "token_cost",
        limitValue: 100,
        model: ["gpt-4o"],
      },
    ]);

    const foundForA = await LimitModel.findLimitsNeedingCleanup(
      orgA.id,
      new Date(),
    );
    expect(foundForA).toHaveLength(1);
    expect(foundForA[0].organizationId).toBe(orgA.id);
  });
});

describe("LimitValidationService.checkLimitsBeforeRequest — ctx-object", () => {
  test("returns null when no limits are configured", async ({ makeAgent }) => {
    const agent = await makeAgent({ name: "No-limits agent" });
    const result = await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
      organizationId: agent.organizationId,
      model: "gpt-4o",
    });
    expect(result).toBeNull();
  });

  test("skips user-scope enforcement when billedUserId is undefined (strict skip)", async ({
    makeAgent,
    makeUser,
    makeOrganization,
  }) => {
    // Create a user-scope limit that is clearly exceeded, but make the request
    // without a billedUserId — the check must NOT fall back to any user.
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });

    const userLimit = await LimitModel.create({
      entityType: "user",
      entityId: user.id,
      organizationId: org.id,
      limitType: "token_cost",
      limitValue: 1,
      model: ["gpt-4o"],
    });
    await exhaustLimit(userLimit.id, "gpt-4o");

    const result = await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
      organizationId: org.id,
      model: "gpt-4o",
      // billedUserId intentionally omitted — vkey / team-api-key path
    });
    expect(result).toBeNull();
  });

  test("skips concrete-model limit when request is for a different model (Decision 8)", async ({
    makeAgent,
    makeOrganization,
  }) => {
    // Org limit: "claude-3-opus" → $10. After exhaustion, an OpenAI request
    // must still be allowed (the Claude-limit does not cover gpt-4o).
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });

    const claudeLimit = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      organizationId: org.id,
      limitType: "token_cost",
      limitValue: 10,
      model: ["claude-3-opus"],
    });
    await exhaustLimit(claudeLimit.id, "claude-3-opus");

    const resultOpenAi = await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
      organizationId: org.id,
      model: "gpt-4o",
    });
    expect(resultOpenAi).toBeNull();

    const resultClaude = await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
      organizationId: org.id,
      model: "claude-3-opus",
    });
    expect(resultClaude).not.toBeNull();
  });

  test("ALL_MODELS_SENTINEL limit gates every incoming model", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });

    const sentinelLimit = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      organizationId: org.id,
      limitType: "token_cost",
      limitValue: 10,
      model: [ALL_MODELS_SENTINEL],
    });
    // Seed a usage row directly, then pin lastCleanup so the cleanup pass
    // does not reset it when checkLimitsBeforeRequest runs.
    await db.insert(schema.limitModelUsageTable).values({
      limitId: sentinelLimit.id,
      model: "gpt-4o",
      currentUsageTokensIn: 10_000_000,
      currentUsageTokensOut: 10_000_000,
    });
    await LimitModel.patch({
      id: sentinelLimit.id,
      data: { lastCleanup: new Date() },
    });

    const resultOpenAi = await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
      organizationId: org.id,
      model: "gpt-4o",
    });
    const resultClaude = await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
      organizationId: org.id,
      model: "claude-3-opus",
    });
    expect(resultOpenAi).not.toBeNull();
    expect(resultClaude).not.toBeNull();
  });

  test("most specific scope wins — vkey blocks before user / agent / org", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const virtualKeyId = "vkey-specific";

    const vkeyLimit = await LimitModel.create({
      entityType: "virtual_api_key",
      entityId: virtualKeyId,
      organizationId: org.id,
      limitType: "token_cost",
      limitValue: 10,
      model: ["gpt-4o"],
    });
    await exhaustLimit(vkeyLimit.id, "gpt-4o");

    const result = await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
      organizationId: org.id,
      model: "gpt-4o",
      virtualKeyId,
    });
    expect(result).not.toBeNull();
    expect(result?.scope).toBe("virtual_api_key");
    expect(result?.contentMessage).toContain(
      "virtual_api_key-level token cost limit",
    );
  });
});

/**
 * Set a limit's `lastCleanup` to now and seed a large usage for the given
 * model so enforcement sees the limit as exceeded. Pinning `lastCleanup`
 * prevents `cleanupLimitsIfNeeded` from resetting the counters before the
 * check runs (cleanup fires when lastCleanup IS NULL).
 */
async function exhaustLimit(limitId: string, model: string) {
  await db
    .insert(schema.limitModelUsageTable)
    .values({
      limitId,
      model,
      currentUsageTokensIn: 10_000_000,
      currentUsageTokensOut: 10_000_000,
    })
    .onConflictDoUpdate({
      target: [
        schema.limitModelUsageTable.limitId,
        schema.limitModelUsageTable.model,
      ],
      set: {
        currentUsageTokensIn: 10_000_000,
        currentUsageTokensOut: 10_000_000,
      },
    });
  await LimitModel.patch({ id: limitId, data: { lastCleanup: new Date() } });
}
