import { AGENT_TOOL_PREFIX } from "@shared";
import { describe, expect, test } from "@/test";
import AgentModel from "./agent";
import PromptModel from "./prompt";
import PromptAgentModel from "./prompt-agent";
import ToolModel from "./tool";

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

  describe("tool creation", () => {
    test("creates a tool when a prompt agent is added", async ({
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
        name: "Research Bot",
        agentId: childAgent.id,
        systemPrompt: "You are a research assistant.",
      });

      await PromptAgentModel.create({
        promptId: parentPrompt.id,
        agentPromptId: childPrompt.id,
      });

      // Verify tool was created
      const tools = await ToolModel.getAgentDelegationToolsByPrompt(
        parentPrompt.id,
      );

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe(`${AGENT_TOOL_PREFIX}research_bot`);
      expect(tools[0].description).toBe("You are a research assistant.");
      expect(tools[0].promptAgentId).toBeDefined();
    });

    test("deletes tool when prompt agent is removed via cascade", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const parentAgent = await AgentModel.create({
        name: "Parent",
        teams: [],
      });
      const childAgent = await AgentModel.create({
        name: "Child",
        teams: [],
      });

      const parentPrompt = await PromptModel.create(org.id, {
        name: "Parent Prompt",
        agentId: parentAgent.id,
      });

      const childPrompt = await PromptModel.create(org.id, {
        name: "Helper Bot",
        agentId: childAgent.id,
      });

      await PromptAgentModel.create({
        promptId: parentPrompt.id,
        agentPromptId: childPrompt.id,
      });

      // Verify tool exists
      let tools = await ToolModel.getAgentDelegationToolsByPrompt(
        parentPrompt.id,
      );
      expect(tools).toHaveLength(1);

      // Delete the prompt agent
      await PromptAgentModel.delete({
        promptId: parentPrompt.id,
        agentPromptId: childPrompt.id,
      });

      // Verify tool was deleted via cascade
      tools = await ToolModel.getAgentDelegationToolsByPrompt(parentPrompt.id);
      expect(tools).toHaveLength(0);
    });

    test("creates tools for new agents when syncing", async ({
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
        name: "Bot One",
        agentId: childAgent1.id,
      });

      const childPrompt2 = await PromptModel.create(org.id, {
        name: "Bot Two",
        agentId: childAgent2.id,
      });

      // Sync to add both agents
      await PromptAgentModel.sync({
        promptId: parentPrompt.id,
        agentPromptIds: [childPrompt1.id, childPrompt2.id],
      });

      // Verify tools were created
      const tools = await ToolModel.getAgentDelegationToolsByPrompt(
        parentPrompt.id,
      );

      expect(tools).toHaveLength(2);
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain(`${AGENT_TOOL_PREFIX}bot_one`);
      expect(toolNames).toContain(`${AGENT_TOOL_PREFIX}bot_two`);
    });
  });

  describe("tool name sync", () => {
    test("updates tool name when prompt is renamed", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const parentAgent = await AgentModel.create({
        name: "Parent",
        teams: [],
      });
      const childAgent = await AgentModel.create({
        name: "Child",
        teams: [],
      });

      const parentPrompt = await PromptModel.create(org.id, {
        name: "Parent Prompt",
        agentId: parentAgent.id,
      });

      const childPrompt = await PromptModel.create(org.id, {
        name: "Original Name",
        agentId: childAgent.id,
      });

      await PromptAgentModel.create({
        promptId: parentPrompt.id,
        agentPromptId: childPrompt.id,
      });

      // Verify original tool name
      let tools = await ToolModel.getAgentDelegationToolsByPrompt(
        parentPrompt.id,
      );
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe(`${AGENT_TOOL_PREFIX}original_name`);

      // Rename the child prompt
      await PromptModel.update(childPrompt.id, { name: "New Name" });

      // Verify tool name was updated
      tools = await ToolModel.getAgentDelegationToolsByPrompt(parentPrompt.id);
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe(`${AGENT_TOOL_PREFIX}new_name`);
    });

    test("preserves delegation when parent prompt is renamed", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const parentAgent = await AgentModel.create({
        name: "Parent",
        teams: [],
      });
      const childAgent = await AgentModel.create({
        name: "Child",
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

      await PromptAgentModel.create({
        promptId: parentPrompt.id,
        agentPromptId: childPrompt.id,
      });

      // Verify delegation exists
      let agents = await PromptAgentModel.findByPromptId(parentPrompt.id);
      expect(agents).toHaveLength(1);

      // Rename the PARENT prompt (updates in place - same ID)
      const updatedParent = await PromptModel.update(parentPrompt.id, {
        name: "Renamed Parent",
      });
      expect(updatedParent).toBeDefined();
      if (!updatedParent) throw new Error("Updated parent should be defined");

      // With JSONB history versioning, the ID stays the same
      expect(updatedParent.id).toBe(parentPrompt.id);

      // Verify delegation is preserved (ID didn't change, no migration needed)
      agents = await PromptAgentModel.findByPromptId(parentPrompt.id);
      expect(agents).toHaveLength(1);
      expect(agents[0].agentPromptId).toBe(childPrompt.id);
    });

    test("preserves delegation when child prompt is renamed", async ({
      makeOrganization,
    }) => {
      const org = await makeOrganization();

      const parentAgent = await AgentModel.create({
        name: "Parent",
        teams: [],
      });
      const childAgent = await AgentModel.create({
        name: "Child",
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

      await PromptAgentModel.create({
        promptId: parentPrompt.id,
        agentPromptId: childPrompt.id,
      });

      // Verify delegation exists
      let agents = await PromptAgentModel.findByPromptId(parentPrompt.id);
      expect(agents).toHaveLength(1);
      expect(agents[0].agentPromptId).toBe(childPrompt.id);

      // Rename the CHILD prompt (creates new version)
      const updatedChild = await PromptModel.update(childPrompt.id, {
        name: "Renamed Child",
      });

      // Verify delegation still exists but points to new child version
      agents = await PromptAgentModel.findByPromptId(parentPrompt.id);
      expect(agents).toHaveLength(1);
      expect(agents[0].agentPromptId).toBe(updatedChild?.id);
    });
  });
});
