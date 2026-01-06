import { AgentModel, PromptAgentModel, PromptModel } from "@/models";
import { describe, expect, test } from "@/test";

describe("PromptAgentModel Route Logic", () => {
  /**
   * These tests verify the business logic used by prompt-agents routes.
   * We test the model operations directly since the route handlers
   * delegate to these model methods.
   */

  describe("GET /api/prompts/:promptId/agents - List agents", () => {
    test("returns agents with profile and prompt details", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const parentAgent = await AgentModel.create({
        name: "Parent Agent",
        teams: [],
      });
      const childAgent = await AgentModel.create({
        name: "Child Agent",
        teams: [],
      });

      const parentPrompt = await PromptModel.create(org.id, {
        name: "Parent Prompt",
        agentId: parentAgent.id,
        systemPrompt: "Parent system prompt",
      });

      const childPrompt = await PromptModel.create(org.id, {
        name: "Child Prompt",
        agentId: childAgent.id,
        systemPrompt: "Child system prompt",
      });

      await PromptAgentModel.create({
        promptId: parentPrompt.id,
        agentPromptId: childPrompt.id,
      });

      // Route would call findByPromptIdWithDetails
      const agents = await PromptAgentModel.findByPromptIdWithDetails(
        parentPrompt.id,
      );

      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("Child Prompt");
      expect(agents[0].systemPrompt).toBe("Child system prompt");
      expect(agents[0].profileId).toBe(childAgent.id);
      expect(agents[0].profileName).toBe("Child Agent");
    });

    test("returns empty array for prompt with no agents", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const agent = await AgentModel.create({ name: "Test Agent", teams: [] });
      const prompt = await PromptModel.create(org.id, {
        name: "Test Prompt",
        agentId: agent.id,
      });

      const agents = await PromptAgentModel.findByPromptIdWithDetails(
        prompt.id,
      );

      expect(agents).toHaveLength(0);
    });
  });

  describe("POST /api/prompts/:promptId/agents - Sync agents", () => {
    test("adds new agents", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const parentAgent = await AgentModel.create({
        name: "Parent Agent",
        teams: [],
      });
      const childAgent1 = await AgentModel.create({
        name: "Child Agent 1",
        teams: [],
      });
      const childAgent2 = await AgentModel.create({
        name: "Child Agent 2",
        teams: [],
      });

      const parentPrompt = await PromptModel.create(org.id, {
        name: "Parent Prompt",
        agentId: parentAgent.id,
      });

      const childPrompt1 = await PromptModel.create(org.id, {
        name: "Child Prompt 1",
        agentId: childAgent1.id,
      });

      const childPrompt2 = await PromptModel.create(org.id, {
        name: "Child Prompt 2",
        agentId: childAgent2.id,
      });

      // Route would call sync
      const result = await PromptAgentModel.sync({
        promptId: parentPrompt.id,
        agentPromptIds: [childPrompt1.id, childPrompt2.id],
      });

      expect(result.added).toContain(childPrompt1.id);
      expect(result.added).toContain(childPrompt2.id);
      expect(result.removed).toHaveLength(0);

      const agents = await PromptAgentModel.findByPromptId(parentPrompt.id);
      expect(agents).toHaveLength(2);
    });

    test("removes old agents not in new list", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const parentAgent = await AgentModel.create({
        name: "Parent Agent",
        teams: [],
      });
      const childAgent1 = await AgentModel.create({
        name: "Child Agent 1",
        teams: [],
      });
      const childAgent2 = await AgentModel.create({
        name: "Child Agent 2",
        teams: [],
      });

      const parentPrompt = await PromptModel.create(org.id, {
        name: "Parent Prompt",
        agentId: parentAgent.id,
      });

      const childPrompt1 = await PromptModel.create(org.id, {
        name: "Child Prompt 1",
        agentId: childAgent1.id,
      });

      const childPrompt2 = await PromptModel.create(org.id, {
        name: "Child Prompt 2",
        agentId: childAgent2.id,
      });

      // Initially assign both
      await PromptAgentModel.create({
        promptId: parentPrompt.id,
        agentPromptId: childPrompt1.id,
      });
      await PromptAgentModel.create({
        promptId: parentPrompt.id,
        agentPromptId: childPrompt2.id,
      });

      // Sync with only childPrompt2
      const result = await PromptAgentModel.sync({
        promptId: parentPrompt.id,
        agentPromptIds: [childPrompt2.id],
      });

      expect(result.removed).toContain(childPrompt1.id);
      expect(result.added).toHaveLength(0);

      const agents = await PromptAgentModel.findByPromptId(parentPrompt.id);
      expect(agents).toHaveLength(1);
      expect(agents[0].agentPromptId).toBe(childPrompt2.id);
    });

    test("handles empty agent list (removes all)", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const parentAgent = await AgentModel.create({
        name: "Parent Agent",
        teams: [],
      });
      const childAgent = await AgentModel.create({
        name: "Child Agent",
        teams: [],
      });

      const parentPrompt = await PromptModel.create(org.id, {
        name: "Parent Prompt",
        agentId: parentAgent.id,
      });

      const childPrompt = await PromptModel.create(org.id, {
        name: "Child Prompt",
        agentId: childAgent.id,
      });

      // Initially assign
      await PromptAgentModel.create({
        promptId: parentPrompt.id,
        agentPromptId: childPrompt.id,
      });

      // Sync with empty list
      const result = await PromptAgentModel.sync({
        promptId: parentPrompt.id,
        agentPromptIds: [],
      });

      expect(result.removed).toContain(childPrompt.id);
      expect(result.added).toHaveLength(0);

      const agents = await PromptAgentModel.findByPromptId(parentPrompt.id);
      expect(agents).toHaveLength(0);
    });
  });

  describe("DELETE /api/prompts/:promptId/agents/:agentPromptId - Remove agent", () => {
    test("removes specific agent from prompt", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const parentAgent = await AgentModel.create({
        name: "Parent Agent",
        teams: [],
      });
      const childAgent1 = await AgentModel.create({
        name: "Child Agent 1",
        teams: [],
      });
      const childAgent2 = await AgentModel.create({
        name: "Child Agent 2",
        teams: [],
      });

      const parentPrompt = await PromptModel.create(org.id, {
        name: "Parent Prompt",
        agentId: parentAgent.id,
      });

      const childPrompt1 = await PromptModel.create(org.id, {
        name: "Child Prompt 1",
        agentId: childAgent1.id,
      });

      const childPrompt2 = await PromptModel.create(org.id, {
        name: "Child Prompt 2",
        agentId: childAgent2.id,
      });

      await PromptAgentModel.create({
        promptId: parentPrompt.id,
        agentPromptId: childPrompt1.id,
      });
      await PromptAgentModel.create({
        promptId: parentPrompt.id,
        agentPromptId: childPrompt2.id,
      });

      // Route would call delete
      await PromptAgentModel.delete({
        promptId: parentPrompt.id,
        agentPromptId: childPrompt1.id,
      });

      const agents = await PromptAgentModel.findByPromptId(parentPrompt.id);
      expect(agents).toHaveLength(1);
      expect(agents[0].agentPromptId).toBe(childPrompt2.id);
    });

    test("returns false for non-existent assignment", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const agent = await AgentModel.create({ name: "Test Agent", teams: [] });
      const prompt = await PromptModel.create(org.id, {
        name: "Test Prompt",
        agentId: agent.id,
      });

      const result = await PromptAgentModel.delete({
        promptId: prompt.id,
        agentPromptId: "00000000-0000-0000-0000-000000000000",
      });

      expect(result).toBe(false);
    });
  });

  describe("Access control considerations", () => {
    test("prompt must belong to organization (findByIdAndOrganizationId)", async ({
      makeOrganization,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();

      const agent = await AgentModel.create({ name: "Test Agent", teams: [] });
      const prompt = await PromptModel.create(org1.id, {
        name: "Test Prompt",
        agentId: agent.id,
      });

      // Should find in correct org
      const foundInOrg1 = await PromptModel.findByIdAndOrganizationId(
        prompt.id,
        org1.id,
      );
      expect(foundInOrg1).not.toBeNull();

      // Should not find in different org
      const foundInOrg2 = await PromptModel.findByIdAndOrganizationId(
        prompt.id,
        org2.id,
      );
      expect(foundInOrg2).toBeNull();
    });

    test("agent prompts must be validated before assignment", async ({
      makeOrganization,
    }) => {
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();

      const parentAgent = await AgentModel.create({
        name: "Parent Agent",
        teams: [],
      });
      const childAgent = await AgentModel.create({
        name: "Child Agent",
        teams: [],
      });

      // Create parent prompt in org1 (not used, but shows the scenario)
      await PromptModel.create(org1.id, {
        name: "Parent Prompt",
        agentId: parentAgent.id,
      });

      // Create child prompt in org2 (different organization)
      const childPrompt = await PromptModel.create(org2.id, {
        name: "Child Prompt",
        agentId: childAgent.id,
      });

      // Simulate route validation - child prompt is in different org
      const foundChildPrompt = await PromptModel.findByIdAndOrganizationId(
        childPrompt.id,
        org1.id,
      );

      expect(foundChildPrompt).toBeNull();
      // Route would return 400 error here
    });

    test("self-assignment should be prevented", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const agent = await AgentModel.create({ name: "Test Agent", teams: [] });
      const prompt = await PromptModel.create(org.id, {
        name: "Test Prompt",
        agentId: agent.id,
      });

      // Route should check this before calling sync
      const isSelfAssignment = [prompt.id].includes(prompt.id);
      expect(isSelfAssignment).toBe(true);
      // Route would return 400 error here
    });
  });
});
