import { describe, expect, test } from "@/test";
import AgentModel from "./agent";
import PromptModel from "./prompt";
import PromptAgentModel from "./prompt-agent";

describe("PromptAgentModel", () => {
  describe("create", () => {
    test("assigns an agent to a prompt", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const agent1 = await AgentModel.create({
        name: "Parent Agent",
        teams: [],
      });
      const agent2 = await AgentModel.create({
        name: "Child Agent",
        teams: [],
      });

      const prompt1 = await PromptModel.create(org.id, {
        name: "Parent Prompt",
        agentId: agent1.id,
      });

      const prompt2 = await PromptModel.create(org.id, {
        name: "Child Prompt",
        agentId: agent2.id,
      });

      const result = await PromptAgentModel.create({
        promptId: prompt1.id,
        agentPromptId: prompt2.id,
      });

      expect(result.id).toBeDefined();
      expect(result.promptId).toBe(prompt1.id);
      expect(result.agentPromptId).toBe(prompt2.id);
    });
  });

  describe("delete", () => {
    test("removes an agent from a prompt", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const agent1 = await AgentModel.create({
        name: "Parent Agent",
        teams: [],
      });
      const agent2 = await AgentModel.create({
        name: "Child Agent",
        teams: [],
      });

      const prompt1 = await PromptModel.create(org.id, {
        name: "Parent Prompt",
        agentId: agent1.id,
      });

      const prompt2 = await PromptModel.create(org.id, {
        name: "Child Prompt",
        agentId: agent2.id,
      });

      await PromptAgentModel.create({
        promptId: prompt1.id,
        agentPromptId: prompt2.id,
      });

      // Verify it exists first
      const agentsBefore = await PromptAgentModel.findByPromptId(prompt1.id);
      expect(agentsBefore).toHaveLength(1);

      await PromptAgentModel.delete({
        promptId: prompt1.id,
        agentPromptId: prompt2.id,
      });

      // Verify it's gone
      const agentsAfter = await PromptAgentModel.findByPromptId(prompt1.id);
      expect(agentsAfter).toHaveLength(0);
    });

    test("returns false when agent not assigned", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const agent1 = await AgentModel.create({
        name: "Parent Agent",
        teams: [],
      });

      const prompt1 = await PromptModel.create(org.id, {
        name: "Parent Prompt",
        agentId: agent1.id,
      });

      const deleted = await PromptAgentModel.delete({
        promptId: prompt1.id,
        agentPromptId: "00000000-0000-0000-0000-000000000000",
      });

      expect(deleted).toBe(false);
    });
  });

  describe("findByPromptId", () => {
    test("returns all agents for a prompt", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const parentAgent = await AgentModel.create({
        name: "Parent",
        teams: [],
      });
      const childAgent1 = await AgentModel.create({
        name: "Child 1",
        teams: [],
      });
      const childAgent2 = await AgentModel.create({
        name: "Child 2",
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

      const agents = await PromptAgentModel.findByPromptId(parentPrompt.id);

      expect(agents).toHaveLength(2);
      expect(agents.map((a) => a.agentPromptId)).toContain(childPrompt1.id);
      expect(agents.map((a) => a.agentPromptId)).toContain(childPrompt2.id);
    });
  });

  describe("findByPromptIdWithDetails", () => {
    test("returns agents with profile and prompt details", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const parentAgent = await AgentModel.create({
        name: "Parent",
        teams: [],
      });
      const childAgent = await AgentModel.create({
        name: "Child Profile",
        teams: [],
      });

      const parentPrompt = await PromptModel.create(org.id, {
        name: "Parent Prompt",
        agentId: parentAgent.id,
      });

      const childPrompt = await PromptModel.create(org.id, {
        name: "Child Prompt",
        agentId: childAgent.id,
        systemPrompt: "You are a helpful assistant.",
      });

      await PromptAgentModel.create({
        promptId: parentPrompt.id,
        agentPromptId: childPrompt.id,
      });

      const agents = await PromptAgentModel.findByPromptIdWithDetails(
        parentPrompt.id,
      );

      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("Child Prompt");
      expect(agents[0].systemPrompt).toBe("You are a helpful assistant.");
      expect(agents[0].profileId).toBe(childAgent.id);
      expect(agents[0].profileName).toBe("Child Profile");
    });

    test("excludes inactive prompts", async ({ makeOrganization }) => {
      const org = await makeOrganization();

      const parentAgent = await AgentModel.create({
        name: "Parent",
        teams: [],
      });
      const childAgent = await AgentModel.create({ name: "Child", teams: [] });

      const parentPrompt = await PromptModel.create(org.id, {
        name: "Parent Prompt",
        agentId: parentAgent.id,
      });

      const childPrompt = await PromptModel.create(org.id, {
        name: "Child Prompt",
        agentId: childAgent.id,
      });

      await PromptAgentModel.create({
        promptId: parentPrompt.id,
        agentPromptId: childPrompt.id,
      });

      // Deactivate the child prompt
      await PromptModel.update(childPrompt.id, { isActive: false });

      const agents = await PromptAgentModel.findByPromptIdWithDetails(
        parentPrompt.id,
      );

      expect(agents).toHaveLength(0);
    });
  });

  describe("sync", () => {
    test("adds new agents and removes old ones", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const parentAgent = await AgentModel.create({
        name: "Parent",
        teams: [],
      });
      const childAgent1 = await AgentModel.create({
        name: "Child 1",
        teams: [],
      });
      const childAgent2 = await AgentModel.create({
        name: "Child 2",
        teams: [],
      });
      const childAgent3 = await AgentModel.create({
        name: "Child 3",
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

      const childPrompt3 = await PromptModel.create(org.id, {
        name: "Child Prompt 3",
        agentId: childAgent3.id,
      });

      // Initially assign child1 and child2
      await PromptAgentModel.create({
        promptId: parentPrompt.id,
        agentPromptId: childPrompt1.id,
      });

      await PromptAgentModel.create({
        promptId: parentPrompt.id,
        agentPromptId: childPrompt2.id,
      });

      // Sync to child2 and child3 (remove child1, add child3)
      const result = await PromptAgentModel.sync({
        promptId: parentPrompt.id,
        agentPromptIds: [childPrompt2.id, childPrompt3.id],
      });

      expect(result.added).toContain(childPrompt3.id);
      expect(result.removed).toContain(childPrompt1.id);

      const agents = await PromptAgentModel.findByPromptId(parentPrompt.id);
      expect(agents).toHaveLength(2);
      expect(agents.map((a) => a.agentPromptId)).toContain(childPrompt2.id);
      expect(agents.map((a) => a.agentPromptId)).toContain(childPrompt3.id);
    });
  });

  describe("bulkAssign", () => {
    test("assigns multiple agents ignoring duplicates", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const parentAgent = await AgentModel.create({
        name: "Parent",
        teams: [],
      });
      const childAgent1 = await AgentModel.create({
        name: "Child 1",
        teams: [],
      });
      const childAgent2 = await AgentModel.create({
        name: "Child 2",
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

      // Assign child1 first
      await PromptAgentModel.create({
        promptId: parentPrompt.id,
        agentPromptId: childPrompt1.id,
      });

      // Bulk assign both (child1 is duplicate)
      const result = await PromptAgentModel.bulkAssign({
        promptId: parentPrompt.id,
        agentPromptIds: [childPrompt1.id, childPrompt2.id],
      });

      expect(result.assigned).toContain(childPrompt2.id);
      expect(result.duplicates).toContain(childPrompt1.id);
      expect(result.assigned).not.toContain(childPrompt1.id);
    });
  });

  describe("hasAgent", () => {
    test("returns true when agent is assigned", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const parentAgent = await AgentModel.create({
        name: "Parent",
        teams: [],
      });
      const childAgent = await AgentModel.create({ name: "Child", teams: [] });

      const parentPrompt = await PromptModel.create(org.id, {
        name: "Parent Prompt",
        agentId: parentAgent.id,
      });

      const childPrompt = await PromptModel.create(org.id, {
        name: "Child Prompt",
        agentId: childAgent.id,
      });

      await PromptAgentModel.create({
        promptId: parentPrompt.id,
        agentPromptId: childPrompt.id,
      });

      const hasAgent = await PromptAgentModel.hasAgent({
        promptId: parentPrompt.id,
        agentPromptId: childPrompt.id,
      });

      expect(hasAgent).toBe(true);
    });

    test("returns false when agent is not assigned", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const parentAgent = await AgentModel.create({
        name: "Parent",
        teams: [],
      });

      const parentPrompt = await PromptModel.create(org.id, {
        name: "Parent Prompt",
        agentId: parentAgent.id,
      });

      const hasAgent = await PromptAgentModel.hasAgent({
        promptId: parentPrompt.id,
        agentPromptId: "00000000-0000-0000-0000-000000000000",
      });

      expect(hasAgent).toBe(false);
    });
  });
});
