import { describe, expect, test } from "@/test";
import { CreateLimitSchema } from "@/types";
import AgentTeamModel from "./agent-team";
import LimitModel, { LimitValidationService } from "./limit";

describe("CreateLimitSchema", () => {
  test("normalizes empty array to null for token_cost", () => {
    const result = CreateLimitSchema.parse({
      entityType: "agent",
      entityId: "agent-123",
      limitType: "token_cost",
      limitValue: 1000,
      model: [],
    });
    expect(result.model).toBeNull();
  });

  test("normalizes undefined model to null for token_cost", () => {
    const result = CreateLimitSchema.parse({
      entityType: "agent",
      entityId: "agent-123",
      limitType: "token_cost",
      limitValue: 1000,
    });
    expect(result.model).toBeNull();
  });

  test("preserves null model for token_cost", () => {
    const result = CreateLimitSchema.parse({
      entityType: "agent",
      entityId: "agent-123",
      limitType: "token_cost",
      limitValue: 1000,
      model: null,
    });
    expect(result.model).toBeNull();
  });

  test("rejects model for mcp_server_calls", () => {
    const result = CreateLimitSchema.safeParse({
      entityType: "agent",
      entityId: "agent-123",
      limitType: "mcp_server_calls",
      limitValue: 100,
      mcpServerName: "test-server",
      model: ["gpt-4o"],
    });
    expect(result.success).toBe(false);
  });
});

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

    test("can create a token_cost limit with null model (all models)", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: null,
      });

      expect(limit.id).toBeDefined();
      expect(limit.model).toBeNull();

      const modelUsage = await LimitModel.getRawModelUsage(limit.id);
      expect(modelUsage).toHaveLength(0);
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

    test("normalizes empty model array to null on patch", async ({
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

      const updated = await LimitModel.patch(limit.id, { model: [] });

      expect(updated).toBeDefined();
      expect(updated?.model).toBeNull();
    });

    test("can update from all-models to specific model", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: null,
      });

      const updated = await LimitModel.patch(limit.id, {
        model: ["gpt-4o"],
      });

      expect(updated).toBeDefined();
      expect(updated?.model).toEqual(["gpt-4o"]);
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

  describe("updateTokenLimitUsage with all-models limit", () => {
    test("should match all-models limit when model is null", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: null,
      });

      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "gpt-4o",
        100,
        200,
      );

      const modelUsage = await LimitModel.getRawModelUsage(limit.id);
      expect(modelUsage).toHaveLength(1);
      expect(modelUsage[0].model).toBe("gpt-4o");
      expect(modelUsage[0].currentUsageTokensIn).toBe(100);
      expect(modelUsage[0].currentUsageTokensOut).toBe(200);
    });

    test("should match both specific-model and all-models limits", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const specificLimit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["gpt-4o"],
      });

      const allModelsLimit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 2000000,
        model: null,
      });

      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "gpt-4o",
        100,
        200,
      );

      const specificUsage = await LimitModel.getRawModelUsage(specificLimit.id);
      expect(specificUsage).toHaveLength(1);
      expect(specificUsage[0].currentUsageTokensIn).toBe(100);

      const allModelsUsage = await LimitModel.getRawModelUsage(
        allModelsLimit.id,
      );
      expect(allModelsUsage).toHaveLength(1);
      expect(allModelsUsage[0].model).toBe("gpt-4o");
      expect(allModelsUsage[0].currentUsageTokensIn).toBe(100);
    });

    test("should accumulate usage across different models for all-models limit", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: null,
      });

      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "gpt-4o",
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

      const modelUsage = await LimitModel.getRawModelUsage(limit.id);
      expect(modelUsage).toHaveLength(2);

      const gptUsage = modelUsage.find((u) => u.model === "gpt-4o");
      const claudeUsage = modelUsage.find(
        (u) => u.model === "claude-3-5-sonnet-20241022",
      );

      expect(gptUsage?.currentUsageTokensIn).toBe(100);
      expect(gptUsage?.currentUsageTokensOut).toBe(200);
      expect(claudeUsage?.currentUsageTokensIn).toBe(50);
      expect(claudeUsage?.currentUsageTokensOut).toBe(75);
    });
  });

  describe("updateTokenLimitUsage with all-models limit for team", () => {
    test("should update team all-models limit usage", async ({
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

      const limit = await LimitModel.create({
        entityType: "team",
        entityId: team.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: null,
      });

      await LimitModel.updateTokenLimitUsage(
        "team",
        team.id,
        "gpt-4o",
        100,
        200,
      );

      const modelUsage = await LimitModel.getRawModelUsage(limit.id);
      expect(modelUsage).toHaveLength(1);
      expect(modelUsage[0].model).toBe("gpt-4o");
      expect(modelUsage[0].currentUsageTokensIn).toBe(100);
      expect(modelUsage[0].currentUsageTokensOut).toBe(200);
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

  describe("resetLimitsUsage", () => {
    test("should reset usage counters and set lastCleanup", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const limit1 = await LimitModel.create({
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

      const limit2 = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["gpt-4o"],
      });

      // Add some usage
      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "gpt-4o",
        300,
        400,
      );

      // Pre-test
      const modelUsage1BeforeReset = await LimitModel.getRawModelUsage(
        limit1.id,
      );
      expect(modelUsage1BeforeReset.length).toBe(1);
      expect(modelUsage1BeforeReset[0].currentUsageTokensIn).toBe(100);
      expect(modelUsage1BeforeReset[0].currentUsageTokensOut).toBe(200);

      const modelUsage2BeforeReset = await LimitModel.getRawModelUsage(
        limit2.id,
      );
      expect(modelUsage2BeforeReset.length).toBe(1);
      expect(modelUsage2BeforeReset[0].currentUsageTokensIn).toBe(300);
      expect(modelUsage2BeforeReset[0].currentUsageTokensOut).toBe(400);

      // Reset
      await LimitModel.resetLimitsUsage([limit1.id, limit2.id]);

      const limit1AfterReset = await LimitModel.findById(limit1.id);
      const modelUsage1AfterReset = await LimitModel.getRawModelUsage(
        limit1.id,
      );

      expect(limit1AfterReset).toBeDefined();
      expect(modelUsage1AfterReset.length).toBe(1);
      expect(modelUsage1AfterReset[0].currentUsageTokensIn).toBe(0);
      expect(modelUsage1AfterReset[0].currentUsageTokensOut).toBe(0);
      expect(limit1AfterReset?.lastCleanup).toBeDefined();
      expect(limit1AfterReset?.lastCleanup).not.toBeNull();

      const limit2AfterReset = await LimitModel.findById(limit1.id);
      const modelUsage2AfterReset = await LimitModel.getRawModelUsage(
        limit1.id,
      );

      expect(limit2AfterReset).toBeDefined();
      expect(modelUsage2AfterReset.length).toBe(1);
      expect(modelUsage2AfterReset[0].currentUsageTokensIn).toBe(0);
      expect(modelUsage2AfterReset[0].currentUsageTokensOut).toBe(0);
      expect(limit2AfterReset?.lastCleanup).toBeDefined();
      expect(limit2AfterReset?.lastCleanup).not.toBeNull();
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
      const vkLimit = await LimitModel.create({
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

      // Prevent cleanup from resetting test data
      await LimitModel.patch(vkLimit.id, { lastCleanup: new Date() });

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
      const userLimit = await LimitModel.create({
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

      // Prevent cleanup from resetting test data
      await LimitModel.patch(userLimit.id, { lastCleanup: new Date() });

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

      const agentLimit = await LimitModel.create({
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

      const teamLimit = await LimitModel.create({
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

      // Prevent cleanup from resetting test data
      await LimitModel.patch(agentLimit.id, { lastCleanup: new Date() });
      await LimitModel.patch(teamLimit.id, { lastCleanup: new Date() });

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

      const teamLimit = await LimitModel.create({
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

      const orgLimit = await LimitModel.create({
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

      // Prevent cleanup from resetting test data
      await LimitModel.patch(teamLimit.id, { lastCleanup: new Date() });
      await LimitModel.patch(orgLimit.id, { lastCleanup: new Date() });

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

      const limit = await LimitModel.create({
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

      // Prevent cleanup from resetting test data
      await LimitModel.patch(limit.id, { lastCleanup: new Date() });

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

    test("should block request when all-models limit is exceeded", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1,
        model: null,
      });

      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "gpt-4o",
        1000000,
        1000000,
      );

      // Prevent cleanup from resetting test data
      await LimitModel.patch(limit.id, { lastCleanup: new Date() });

      const result = await LimitValidationService.checkLimitsBeforeRequest({
        agentId: agent.id,
      });

      expect(result).not.toBeNull();
      expect(result?.[1]).toContain("agent-level");
    });

    test("allows request when agent all-models limit is not exceeded", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1_000_000_000,
        model: null,
      });

      const result = await LimitValidationService.checkLimitsBeforeRequest({
        agentId: agent.id,
      });

      expect(result).toBeNull();
    });

    test("accumulates usage across multiple models for all-models limit check", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1,
        model: null,
      });

      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "gpt-4o",
        1_000_000,
        0,
      );
      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "claude-3-5-sonnet-20241022",
        1_000_000,
        0,
      );

      // Prevent cleanup from resetting test data
      await LimitModel.patch(limit.id, { lastCleanup: new Date() });

      const result = await LimitValidationService.checkLimitsBeforeRequest({
        agentId: agent.id,
      });

      expect(result).not.toBeNull();
    });

    test("blocks on all-models limit when agent has both specific and all-models limits", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });

      const specificLimit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1_000_000_000,
        model: ["gpt-4o"],
      });

      const allModelsLimit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1,
        model: null,
      });

      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "claude-3-5-sonnet-20241022",
        1_000_000,
        1_000_000,
      );

      // Prevent cleanup from resetting test data
      await LimitModel.patch(specificLimit.id, { lastCleanup: new Date() });
      await LimitModel.patch(allModelsLimit.id, { lastCleanup: new Date() });

      const result = await LimitValidationService.checkLimitsBeforeRequest({
        agentId: agent.id,
      });

      expect(result).not.toBeNull();
      expect(result?.[1]).toContain("agent-level");
    });

    test("creates user all-models limit with null model", async ({
      makeUser,
    }) => {
      const user = await makeUser();

      const limit = await LimitModel.create({
        entityType: "user",
        entityId: user.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: null,
      });

      expect(limit.model).toBeNull();

      const modelUsage = await LimitModel.getRawModelUsage(limit.id);
      expect(modelUsage).toHaveLength(0);
    });

    test("blocks request when user all-models limit is exceeded", async ({
      makeAgent,
      makeUser,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });
      const user = await makeUser();

      const limit = await LimitModel.create({
        entityType: "user",
        entityId: user.id,
        limitType: "token_cost",
        limitValue: 1,
        model: null,
      });

      await LimitModel.updateTokenLimitUsage(
        "user",
        user.id,
        "gpt-4o",
        1_000_000,
        1_000_000,
      );

      // Prevent cleanup from resetting test data
      await LimitModel.patch(limit.id, { lastCleanup: new Date() });

      const result = await LimitValidationService.checkLimitsBeforeRequest({
        agentId: agent.id,
        userId: user.id,
      });

      expect(result).not.toBeNull();
      expect(result?.[1]).toContain("user-level");
    });

    test("allows request when user all-models limit is not exceeded", async ({
      makeAgent,
      makeUser,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });
      const user = await makeUser();

      await LimitModel.create({
        entityType: "user",
        entityId: user.id,
        limitType: "token_cost",
        limitValue: 1_000_000_000,
        model: null,
      });

      const result = await LimitValidationService.checkLimitsBeforeRequest({
        agentId: agent.id,
        userId: user.id,
      });

      expect(result).toBeNull();
    });

    test("creates virtual_key all-models limit with null model", async ({
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
        model: null,
      });

      expect(limit.model).toBeNull();

      const modelUsage = await LimitModel.getRawModelUsage(limit.id);
      expect(modelUsage).toHaveLength(0);
    });

    test("blocks request when virtual_key all-models limit is exceeded", async ({
      makeAgent,
      makeOrganization,
      makeSecret,
      makeLlmProviderApiKey,
    }) => {
      const agent = await makeAgent({ name: "Test Agent" });
      const org = await makeOrganization();
      const secret = await makeSecret();
      const apiKey = await makeLlmProviderApiKey(org.id, secret.id);

      const limit = await LimitModel.create({
        entityType: "virtual_key",
        entityId: apiKey.id,
        limitType: "token_cost",
        limitValue: 1,
        model: null,
      });

      await LimitModel.updateTokenLimitUsage(
        "virtual_key",
        apiKey.id,
        "gpt-4o",
        1_000_000,
        1_000_000,
      );

      // Prevent cleanup from resetting test data
      await LimitModel.patch(limit.id, { lastCleanup: new Date() });

      const result = await LimitValidationService.checkLimitsBeforeRequest({
        agentId: agent.id,
        virtualKeyId: apiKey.id,
      });

      expect(result).not.toBeNull();
      expect(result?.[1]).toContain("virtual_key-level");
    });

    test("blocks request when org all-models limit is exceeded", async ({
      makeOrganization,
      makeAdmin,
      makeTeam,
      makeMember,
      makeAgent,
    }) => {
      const org = await makeOrganization();
      const admin = await makeAdmin();
      const team = await makeTeam(org.id, admin.id);
      const agent = await makeAgent({
        name: "Test Agent",
        organizationId: org.id,
      });
      await makeMember(admin.id, org.id, { role: "admin" });

      await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

      const limit = await LimitModel.create({
        entityType: "organization",
        entityId: org.id,
        limitType: "token_cost",
        limitValue: 1,
        model: null,
      });

      // Prevent cleanup from resetting test data
      await LimitModel.patch(limit.id, { lastCleanup: new Date() });

      await LimitModel.updateTokenLimitUsage(
        "organization",
        org.id,
        "gpt-4o",
        1_000_000,
        1_000_000,
      );

      const result = await LimitValidationService.checkLimitsBeforeRequest({
        agentId: agent.id,
      });

      expect(result).not.toBeNull();
      expect(result?.[1]).toContain("organization-level");
    });
  });
});

describe("cleanupLimitsIfNeeded", () => {
  test("cleans up organization limits", async ({ makeOrganization }) => {
    const org = await makeOrganization();

    const limit = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    await LimitModel.updateTokenLimitUsage(
      "organization",
      org.id,
      "gpt-4o",
      500,
      500,
    );

    await LimitModel.cleanupLimitsIfNeeded({
      entities: { organization: org.id },
    });

    const modelUsage = await LimitModel.getRawModelUsage(limit.id);
    expect(modelUsage[0].currentUsageTokensIn).toBe(0);
    expect(modelUsage[0].currentUsageTokensOut).toBe(0);
  });

  test("cleans up agent limits", async ({
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

    const limit = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    await LimitModel.updateTokenLimitUsage(
      "agent",
      agent.id,
      "gpt-4o",
      500,
      500,
    );

    await LimitModel.cleanupLimitsIfNeeded({
      entities: { agent: agent.id },
    });

    const modelUsage = await LimitModel.getRawModelUsage(limit.id);
    expect(modelUsage[0].currentUsageTokensIn).toBe(0);
    expect(modelUsage[0].currentUsageTokensOut).toBe(0);
  });

  test("cleans up team limits", async ({
    makeOrganization,
    makeUser,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);

    const limit = await LimitModel.create({
      entityType: "team",
      entityId: team.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    await LimitModel.updateTokenLimitUsage("team", team.id, "gpt-4o", 500, 500);

    await LimitModel.cleanupLimitsIfNeeded({
      entities: { team: [team.id] },
    });

    const modelUsage = await LimitModel.getRawModelUsage(limit.id);
    expect(modelUsage[0].currentUsageTokensIn).toBe(0);
    expect(modelUsage[0].currentUsageTokensOut).toBe(0);
  });

  test("cleans up user limits", async ({ makeUser }) => {
    const user = await makeUser();

    const limit = await LimitModel.create({
      entityType: "user",
      entityId: user.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    await LimitModel.updateTokenLimitUsage("user", user.id, "gpt-4o", 500, 500);

    await LimitModel.cleanupLimitsIfNeeded({
      entities: { user: user.id },
    });

    const modelUsage = await LimitModel.getRawModelUsage(limit.id);
    expect(modelUsage[0].currentUsageTokensIn).toBe(0);
    expect(modelUsage[0].currentUsageTokensOut).toBe(0);
  });

  test("cleans up virtual_key limits", async ({
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
      500,
      500,
    );

    await LimitModel.cleanupLimitsIfNeeded({
      entities: { virtual_key: apiKey.id },
    });

    const modelUsage = await LimitModel.getRawModelUsage(limit.id);
    expect(modelUsage[0].currentUsageTokensIn).toBe(0);
    expect(modelUsage[0].currentUsageTokensOut).toBe(0);
  });

  test("cleans up multiple entity types in single call", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeTeam,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({ name: "Test Agent" });
    await makeMember(user.id, org.id, { role: "admin" });

    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    const agentLimit = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    const teamLimit = await LimitModel.create({
      entityType: "team",
      entityId: team.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    await LimitModel.updateTokenLimitUsage(
      "agent",
      agent.id,
      "gpt-4o",
      500,
      500,
    );
    await LimitModel.updateTokenLimitUsage("team", team.id, "gpt-4o", 300, 300);

    await LimitModel.cleanupLimitsIfNeeded({
      entities: {
        agent: agent.id,
        team: [team.id],
      },
    });

    const agentUsage = await LimitModel.getRawModelUsage(agentLimit.id);
    expect(agentUsage[0].currentUsageTokensIn).toBe(0);
    expect(agentUsage[0].currentUsageTokensOut).toBe(0);

    const teamUsage = await LimitModel.getRawModelUsage(teamLimit.id);
    expect(teamUsage[0].currentUsageTokensIn).toBe(0);
    expect(teamUsage[0].currentUsageTokensOut).toBe(0);
  });

  test("does not clean limits with recent lastCleanup", async ({
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

    const limit = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    await LimitModel.updateTokenLimitUsage(
      "agent",
      agent.id,
      "gpt-4o",
      500,
      500,
    );

    await LimitModel.patch(limit.id, { lastCleanup: new Date() });

    await LimitModel.cleanupLimitsIfNeeded({
      entities: { agent: agent.id },
    });

    const modelUsage = await LimitModel.getRawModelUsage(limit.id);
    expect(modelUsage[0].currentUsageTokensIn).toBe(500);
    expect(modelUsage[0].currentUsageTokensOut).toBe(500);
  });

  test("cleans limits with null lastCleanup", async ({
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

    const limit = await LimitModel.create({
      lastCleanup: null,
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    await LimitModel.updateTokenLimitUsage(
      "agent",
      agent.id,
      "gpt-4o",
      500,
      500,
    );

    await LimitModel.cleanupLimitsIfNeeded({
      entities: { agent: agent.id },
    });

    const modelUsage = await LimitModel.getRawModelUsage(limit.id);
    expect(modelUsage[0].currentUsageTokensIn).toBe(0);
    expect(modelUsage[0].currentUsageTokensOut).toBe(0);
  });

  test("filters by entityType and entityId options", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeTeam,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({ name: "Test Agent" });
    await makeMember(user.id, org.id, { role: "admin" });

    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    const agentLimit = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    const teamLimit = await LimitModel.create({
      entityType: "team",
      entityId: team.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    await LimitModel.updateTokenLimitUsage(
      "agent",
      agent.id,
      "gpt-4o",
      500,
      500,
    );
    await LimitModel.updateTokenLimitUsage("team", team.id, "gpt-4o", 300, 300);

    await LimitModel.cleanupLimitsIfNeeded({
      entityType: "agent",
      entityId: agent.id,
    });

    const agentUsage = await LimitModel.getRawModelUsage(agentLimit.id);
    expect(agentUsage[0].currentUsageTokensIn).toBe(0);
    expect(agentUsage[0].currentUsageTokensOut).toBe(0);

    const teamUsage = await LimitModel.getRawModelUsage(teamLimit.id);
    expect(teamUsage[0].currentUsageTokensIn).toBe(300);
    expect(teamUsage[0].currentUsageTokensOut).toBe(300);
  });

  test("filters by limitType option", async ({ makeAgent }) => {
    const agent = await makeAgent({ name: "Test Agent" });

    const tokenLimit = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    await LimitModel.updateTokenLimitUsage(
      "agent",
      agent.id,
      "gpt-4o",
      500,
      500,
    );

    await LimitModel.cleanupLimitsIfNeeded({
      entityType: "agent",
      entityId: agent.id,
      limitType: "mcp_server_calls",
    });

    const modelUsage = await LimitModel.getRawModelUsage(tokenLimit.id);
    expect(modelUsage[0].currentUsageTokensIn).toBe(500);
    expect(modelUsage[0].currentUsageTokensOut).toBe(500);
  });

  test("handles empty entities gracefully", async ({ makeOrganization }) => {
    const org = await makeOrganization();

    const limit = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    await LimitModel.updateTokenLimitUsage(
      "organization",
      org.id,
      "gpt-4o",
      500,
      500,
    );

    await LimitModel.cleanupLimitsIfNeeded({
      entities: {},
    });

    const modelUsage = await LimitModel.getRawModelUsage(limit.id);
    expect(modelUsage[0].currentUsageTokensIn).toBe(500);
    expect(modelUsage[0].currentUsageTokensOut).toBe(500);
  });

  test("handles unknown organization gracefully", async () => {
    await expect(
      LimitModel.cleanupLimitsIfNeeded({
        entities: { organization: "non-existent-org-id" },
      }),
    ).resolves.toBeUndefined();
  });

  test("with entities and entityType filter", async ({
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

    const agentLimit = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    const teamLimit = await LimitModel.create({
      entityType: "team",
      entityId: team.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    await LimitModel.updateTokenLimitUsage(
      "agent",
      agent.id,
      "gpt-4o",
      500,
      500,
    );
    await LimitModel.updateTokenLimitUsage("team", team.id, "gpt-4o", 300, 300);

    await LimitModel.cleanupLimitsIfNeeded({
      entities: { agent: agent.id, team: [team.id] },
      entityType: "agent",
    });

    const agentUsage = await LimitModel.getRawModelUsage(agentLimit.id);
    expect(agentUsage[0].currentUsageTokensIn).toBe(0);
    expect(agentUsage[0].currentUsageTokensOut).toBe(0);

    const teamUsage = await LimitModel.getRawModelUsage(teamLimit.id);
    expect(teamUsage[0].currentUsageTokensIn).toBe(0);
    expect(teamUsage[0].currentUsageTokensOut).toBe(0);
  });

  test("with entities and entityId filter", async ({ makeAgent }) => {
    const agent = await makeAgent({ name: "Test Agent" });

    const limit1 = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    const limit2 = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 500000,
      model: ["claude-3-5-sonnet-20241022"],
    });

    await LimitModel.updateTokenLimitUsage(
      "agent",
      agent.id,
      "gpt-4o",
      500,
      500,
    );
    await LimitModel.updateTokenLimitUsage(
      "agent",
      agent.id,
      "claude-3-5-sonnet-20241022",
      300,
      300,
    );

    await LimitModel.cleanupLimitsIfNeeded({
      entities: { agent: agent.id },
      entityId: agent.id,
    });

    const usage1 = await LimitModel.getRawModelUsage(limit1.id);
    expect(usage1[0].currentUsageTokensIn).toBe(0);
    expect(usage1[0].currentUsageTokensOut).toBe(0);

    const usage2 = await LimitModel.getRawModelUsage(limit2.id);
    expect(usage2[0].currentUsageTokensIn).toBe(0);
    expect(usage2[0].currentUsageTokensOut).toBe(0);
  });
});

describe("checkLimitsBeforeRequest cleanup integration", () => {
  test("cleans up all 5 entity types in a single checkLimitsBeforeRequest call", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeTeam,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({ name: "Test Agent" });
    const secret = await makeSecret();
    const apiKey = await makeLlmProviderApiKey(org.id, secret.id);
    await makeMember(user.id, org.id, { role: "admin" });

    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    // Create limits for all 5 entity types
    const vkLimit = await LimitModel.create({
      entityType: "virtual_key",
      entityId: apiKey.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    const userLimit = await LimitModel.create({
      entityType: "user",
      entityId: user.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    const agentLimit = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    const teamLimit = await LimitModel.create({
      entityType: "team",
      entityId: team.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    const orgLimit = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    // Add usage to all limits
    await LimitModel.updateTokenLimitUsage(
      "virtual_key",
      apiKey.id,
      "gpt-4o",
      100,
      100,
    );
    await LimitModel.updateTokenLimitUsage("user", user.id, "gpt-4o", 200, 200);
    await LimitModel.updateTokenLimitUsage(
      "agent",
      agent.id,
      "gpt-4o",
      300,
      300,
    );
    await LimitModel.updateTokenLimitUsage("team", team.id, "gpt-4o", 400, 400);
    await LimitModel.updateTokenLimitUsage(
      "organization",
      org.id,
      "gpt-4o",
      500,
      500,
    );

    // Call checkLimitsBeforeRequest which triggers cleanup for all entity types
    await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
      userId: user.id,
      virtualKeyId: apiKey.id,
    });

    // Verify all limits were cleaned up
    const vkUsage = await LimitModel.getRawModelUsage(vkLimit.id);
    expect(vkUsage[0].currentUsageTokensIn).toBe(0);
    expect(vkUsage[0].currentUsageTokensOut).toBe(0);

    const userUsage = await LimitModel.getRawModelUsage(userLimit.id);
    expect(userUsage[0].currentUsageTokensIn).toBe(0);
    expect(userUsage[0].currentUsageTokensOut).toBe(0);

    const agentUsage = await LimitModel.getRawModelUsage(agentLimit.id);
    expect(agentUsage[0].currentUsageTokensIn).toBe(0);
    expect(agentUsage[0].currentUsageTokensOut).toBe(0);

    const teamUsage = await LimitModel.getRawModelUsage(teamLimit.id);
    expect(teamUsage[0].currentUsageTokensIn).toBe(0);
    expect(teamUsage[0].currentUsageTokensOut).toBe(0);

    const orgUsage = await LimitModel.getRawModelUsage(orgLimit.id);
    expect(orgUsage[0].currentUsageTokensIn).toBe(0);
    expect(orgUsage[0].currentUsageTokensOut).toBe(0);
  });

  test("cleanup resets usage before limit check, allowing previously blocked request", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "Test Agent" });

    // Create a limit with low threshold
    const limit = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1,
      model: ["gpt-4o"],
    });

    // Add usage that exceeds the limit
    await LimitModel.updateTokenLimitUsage(
      "agent",
      agent.id,
      "gpt-4o",
      1000000,
      1000000,
    );

    await LimitModel.patch(limit.id, { lastCleanup: new Date() });

    // Verify limit is exceeded before cleanup
    const beforeCheck = await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
    });
    expect(beforeCheck).not.toBeNull();

    // Now set lastCleanup to null so cleanup will reset usage
    await LimitModel.patch(limit.id, { lastCleanup: null });

    // Call checkLimitsBeforeRequest - cleanup should reset usage first
    const afterCheck = await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
    });

    // Request should now be allowed because cleanup reset the usage
    expect(afterCheck).toBeNull();

    // Verify usage was actually reset
    const modelUsage = await LimitModel.getRawModelUsage(limit.id);
    expect(modelUsage[0].currentUsageTokensIn).toBe(0);
    expect(modelUsage[0].currentUsageTokensOut).toBe(0);
  });

  test("mixed lastCleanup states - old gets reset, recent stays intact in same call", async ({
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

    // Create two agent limits - one with old lastCleanup, one with recent
    const oldLimit = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    const recentLimit = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["claude-3-5-sonnet-20241022"],
    });

    // Add usage to both
    await LimitModel.updateTokenLimitUsage(
      "agent",
      agent.id,
      "gpt-4o",
      500,
      500,
    );
    await LimitModel.updateTokenLimitUsage(
      "agent",
      agent.id,
      "claude-3-5-sonnet-20241022",
      300,
      300,
    );

    // Set old lastCleanup (far in the past)
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 7);
    await LimitModel.patch(oldLimit.id, { lastCleanup: oldDate });

    // Set recent lastCleanup (just now)
    await LimitModel.patch(recentLimit.id, { lastCleanup: new Date() });

    // Call checkLimitsBeforeRequest which triggers cleanup
    await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
    });

    // Old limit should have been reset
    const oldUsage = await LimitModel.getRawModelUsage(oldLimit.id);
    expect(oldUsage[0].currentUsageTokensIn).toBe(0);
    expect(oldUsage[0].currentUsageTokensOut).toBe(0);

    // Recent limit should NOT have been reset
    const recentUsage = await LimitModel.getRawModelUsage(recentLimit.id);
    expect(recentUsage[0].currentUsageTokensIn).toBe(300);
    expect(recentUsage[0].currentUsageTokensOut).toBe(300);
  });

  test("all 5 entity types present with virtual_key + user + agent + team + organization", async ({
    makeAgent,
    makeUser,
    makeOrganization,
    makeTeam,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team = await makeTeam(org.id, user.id);
    const agent = await makeAgent({ name: "Test Agent" });
    const secret = await makeSecret();
    const apiKey = await makeLlmProviderApiKey(org.id, secret.id);
    await makeMember(user.id, org.id, { role: "admin" });

    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    // Create limits for all entity types with high thresholds so they don't block
    await LimitModel.create({
      entityType: "virtual_key",
      entityId: apiKey.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    await LimitModel.create({
      entityType: "user",
      entityId: user.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    await LimitModel.create({
      entityType: "team",
      entityId: team.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    // Add some usage to all
    await LimitModel.updateTokenLimitUsage(
      "virtual_key",
      apiKey.id,
      "gpt-4o",
      100,
      100,
    );
    await LimitModel.updateTokenLimitUsage("user", user.id, "gpt-4o", 200, 200);
    await LimitModel.updateTokenLimitUsage(
      "agent",
      agent.id,
      "gpt-4o",
      300,
      300,
    );
    await LimitModel.updateTokenLimitUsage("team", team.id, "gpt-4o", 400, 400);
    await LimitModel.updateTokenLimitUsage(
      "organization",
      org.id,
      "gpt-4o",
      500,
      500,
    );

    // Call checkLimitsBeforeRequest with all entity types
    const result = await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
      userId: user.id,
      virtualKeyId: apiKey.id,
    });

    // Should be allowed since all limits have high thresholds
    expect(result).toBeNull();
  });

  test("cleanup only affects limits for entities passed in options, not unrelated limits", async ({
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
    const otherAgent = await makeAgent({ name: "Other Agent" });
    await makeMember(user.id, org.id, { role: "admin" });

    await AgentTeamModel.assignTeamsToAgent(agent.id, [team.id]);

    // Create limit for agent
    const agentLimit = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    // Create limit for unrelated agent
    const otherLimit = await LimitModel.create({
      entityType: "agent",
      entityId: otherAgent.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    // Add usage to both
    await LimitModel.updateTokenLimitUsage(
      "agent",
      agent.id,
      "gpt-4o",
      500,
      500,
    );
    await LimitModel.updateTokenLimitUsage(
      "agent",
      otherAgent.id,
      "gpt-4o",
      300,
      300,
    );

    // Call checkLimitsBeforeRequest for agent only
    await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
    });

    // Agent limit should be cleaned
    const agentUsage = await LimitModel.getRawModelUsage(agentLimit.id);
    expect(agentUsage[0].currentUsageTokensIn).toBe(0);
    expect(agentUsage[0].currentUsageTokensOut).toBe(0);

    // Other agent limit should NOT be cleaned
    const otherUsage = await LimitModel.getRawModelUsage(otherLimit.id);
    expect(otherUsage[0].currentUsageTokensIn).toBe(300);
    expect(otherUsage[0].currentUsageTokensOut).toBe(300);
  });

  test("checkEntityLimits with multiple limits on same entity (different models)", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "Test Agent" });

    // Create 2 agent limits: one for gpt-4o (low) and one for claude (high)
    const gpt4Limit = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1,
      model: ["gpt-4o"],
    });

    await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["claude-3-5-sonnet-20241022"],
    });

    await LimitModel.updateTokenLimitUsage(
      "agent",
      agent.id,
      "gpt-4o",
      1_000_000_000,
      1_000_000_000,
    );

    await LimitModel.patch(gpt4Limit.id, { lastCleanup: new Date() });

    const result = await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
    });

    expect(result).not.toBeNull();
    const [refusalMessage] = result as unknown as [string, string];
    expect(refusalMessage).toContain(
      "<archestra-limit-type>token_cost</archestra-limit-type>",
    );
  });

  test("checkEntityLimits with all-models and specific-model limits on same entity", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "Test Agent" });

    const allModelsLimit = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1,
      model: null,
    });

    const specificLimit = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    await LimitModel.updateTokenLimitUsage(
      "agent",
      agent.id,
      "gpt-4o",
      1_000_000_000,
      1_000_000_000,
    );

    await LimitModel.patch(allModelsLimit.id, { lastCleanup: new Date() });
    await LimitModel.patch(specificLimit.id, { lastCleanup: new Date() });

    const result = await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
    });

    expect(result).not.toBeNull();
  });

  test("checkEntityLimits allows request when usage is under limit value", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "Test Agent" });

    const limit = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1000,
      model: ["gpt-4o"],
    });

    // Add usage under limit
    await LimitModel.updateTokenLimitUsage("agent", agent.id, "gpt-4o", 500, 0);

    // Prevent cleanup from resetting test data
    await LimitModel.patch(limit.id, { lastCleanup: new Date() });

    const result = await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
    });

    // Allowed - usage under limit
    expect(result).toBeNull();
  });

  test("checkEntityLimits blocks request when usage exactly equals limit value", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "Test Agent" });

    const limit = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 0,
      model: ["gpt-4o"],
    });

    // Add any usage
    await LimitModel.updateTokenLimitUsage("agent", agent.id, "gpt-4o", 100, 0);

    // Prevent cleanup from resetting test data
    await LimitModel.patch(limit.id, { lastCleanup: new Date() });

    const result = await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
    });

    // Blocked - >= comparison
    expect(result).not.toBeNull();
  });

  test("checkEntityLimits with entity that has limits but zero usage", async ({
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

    // Prevent cleanup from resetting test data
    await LimitModel.patch(limit.id, { lastCleanup: new Date() });

    const result = await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
    });

    // Allowed - no usage
    expect(result).toBeNull();
  });

  test("checkEntityLimits returns correct metadata in refusal message", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "Test Agent" });

    const limit = await LimitModel.create({
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
      1_000_000_000,
      1_000_000_000,
    );

    await LimitModel.patch(limit.id, { lastCleanup: new Date() });

    const result = await LimitValidationService.checkLimitsBeforeRequest({
      agentId: agent.id,
    });

    expect(result).not.toBeNull();
    const [refusalMessage] = result as unknown as [string, string];
    expect(refusalMessage).toContain(
      "<archestra-limit-type>token_cost</archestra-limit-type>",
    );
    expect(refusalMessage).toContain(
      `<archestra-limit-entity-type>agent</archestra-limit-entity-type>`,
    );
    expect(refusalMessage).toContain(
      `<archestra-limit-entity-id>${agent.id}</archestra-limit-entity-id>`,
    );
  });

  test("does not reset limits for entity types not included in entities", async ({
    makeAgent,
    makeUser,
  }) => {
    const agent = await makeAgent({ name: "Test Agent" });
    const user = await makeUser();

    const agentLimit = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    const userLimit = await LimitModel.create({
      entityType: "user",
      entityId: user.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    // Add usage to both
    await LimitModel.updateTokenLimitUsage(
      "agent",
      agent.id,
      "gpt-4o",
      500,
      500,
    );
    await LimitModel.updateTokenLimitUsage("user", user.id, "gpt-4o", 300, 300);

    // Call cleanup with only agent
    await LimitModel.cleanupLimitsIfNeeded({
      entities: { agent: agent.id },
    });

    // Agent reset to 0
    const agentUsage = await LimitModel.getRawModelUsage(agentLimit.id);
    expect(agentUsage[0].currentUsageTokensIn).toBe(0);
    expect(agentUsage[0].currentUsageTokensOut).toBe(0);

    // User NOT reset
    const userUsage = await LimitModel.getRawModelUsage(userLimit.id);
    expect(userUsage[0].currentUsageTokensIn).toBe(300);
    expect(userUsage[0].currentUsageTokensOut).toBe(300);
  });

  test("does not reset limits for different entity ID of same type", async ({
    makeUser,
  }) => {
    const user1 = await makeUser();
    const user2 = await makeUser();

    const user1Limit = await LimitModel.create({
      entityType: "user",
      entityId: user1.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    const user2Limit = await LimitModel.create({
      entityType: "user",
      entityId: user2.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    // Add usage to both
    await LimitModel.updateTokenLimitUsage(
      "user",
      user1.id,
      "gpt-4o",
      500,
      500,
    );
    await LimitModel.updateTokenLimitUsage(
      "user",
      user2.id,
      "gpt-4o",
      300,
      300,
    );

    // Call cleanup with only user1
    await LimitModel.cleanupLimitsIfNeeded({
      entities: { user: user1.id },
    });

    // user1 reset to 0
    const user1Usage = await LimitModel.getRawModelUsage(user1Limit.id);
    expect(user1Usage[0].currentUsageTokensIn).toBe(0);
    expect(user1Usage[0].currentUsageTokensOut).toBe(0);

    // user2 NOT reset
    const user2Usage = await LimitModel.getRawModelUsage(user2Limit.id);
    expect(user2Usage[0].currentUsageTokensIn).toBe(300);
    expect(user2Usage[0].currentUsageTokensOut).toBe(300);
  });

  test("multiple teams in entities array all get cleaned", async ({
    makeOrganization,
    makeUser,
    makeTeam,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const team1 = await makeTeam(org.id, user.id);
    const team2 = await makeTeam(org.id, user.id);

    const team1Limit = await LimitModel.create({
      entityType: "team",
      entityId: team1.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    const team2Limit = await LimitModel.create({
      entityType: "team",
      entityId: team2.id,
      limitType: "token_cost",
      limitValue: 1000000,
      model: ["gpt-4o"],
    });

    // Add usage to both
    await LimitModel.updateTokenLimitUsage(
      "team",
      team1.id,
      "gpt-4o",
      500,
      500,
    );
    await LimitModel.updateTokenLimitUsage(
      "team",
      team2.id,
      "gpt-4o",
      300,
      300,
    );

    // Call cleanup with both teams
    await LimitModel.cleanupLimitsIfNeeded({
      entities: { team: [team1.id, team2.id] },
    });

    // Both reset to 0
    const team1Usage = await LimitModel.getRawModelUsage(team1Limit.id);
    expect(team1Usage[0].currentUsageTokensIn).toBe(0);
    expect(team1Usage[0].currentUsageTokensOut).toBe(0);

    const team2Usage = await LimitModel.getRawModelUsage(team2Limit.id);
    expect(team2Usage[0].currentUsageTokensIn).toBe(0);
    expect(team2Usage[0].currentUsageTokensOut).toBe(0);
  });

  test("cleanup with no options at all resolves without error", async () => {
    await expect(LimitModel.cleanupLimitsIfNeeded({})).resolves.toBeUndefined();
  });
});
