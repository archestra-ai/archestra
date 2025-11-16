import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import type { AssignAgentPrompts, InsertAgentPrompt } from "@/types";
import AgentPromptModel from "./agent-prompt";
import PromptModel from "./prompt";

describe("AgentPromptModel", () => {
  describe("create", () => {
    test("creates a single agent-prompt relationship", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent();

      const prompt = await PromptModel.create(org.id, user.id, {
        name: "Test Prompt",
        type: "system",
        content: "You are a helpful assistant.",
      });

      const agentPromptData: InsertAgentPrompt = {
        agentId: agent.id,
        promptId: prompt.id,
        order: 1,
      };

      const agentPrompt = await AgentPromptModel.create(agentPromptData);

      expect(agentPrompt.id).toBeDefined();
      expect(agentPrompt.agentId).toBe(agent.id);
      expect(agentPrompt.promptId).toBe(prompt.id);
      expect(agentPrompt.order).toBe(1);
      expect(agentPrompt.createdAt).toBeInstanceOf(Date);
    });

    test("defaults order to 0 when not provided", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent();

      const prompt = await PromptModel.create(org.id, user.id, {
        name: "Test Prompt",
        type: "system",
        content: "You are a helpful assistant.",
      });

      const agentPromptData: InsertAgentPrompt = {
        agentId: agent.id,
        promptId: prompt.id,
      };

      const agentPrompt = await AgentPromptModel.create(agentPromptData);

      expect(agentPrompt.order).toBe(0);
    });

    test("enforces unique constraint on agent-prompt combination", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent();

      const prompt = await PromptModel.create(org.id, user.id, {
        name: "Test Prompt",
        type: "system",
        content: "You are a helpful assistant.",
      });

      // Create first relationship
      await AgentPromptModel.create({
        agentId: agent.id,
        promptId: prompt.id,
        order: 1,
      });

      // Try to create duplicate relationship - should fail
      await expect(
        AgentPromptModel.create({
          agentId: agent.id,
          promptId: prompt.id,
          order: 2,
        }),
      ).rejects.toThrow();
    });
  });

  describe("findByAgentId", () => {
    test("finds all prompts assigned to an agent ordered by order field", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent();

      // Create multiple prompts
      const prompt1 = await PromptModel.create(org.id, user.id, {
        name: "First Prompt",
        type: "system",
        content: "First prompt content",
      });

      const prompt2 = await PromptModel.create(org.id, user.id, {
        name: "Second Prompt",
        type: "regular",
        content: "Second prompt content",
      });

      const prompt3 = await PromptModel.create(org.id, user.id, {
        name: "Third Prompt",
        type: "regular",
        content: "Third prompt content",
      });

      // Assign prompts in non-sequential order
      await AgentPromptModel.create({
        agentId: agent.id,
        promptId: prompt2.id,
        order: 2,
      });

      await AgentPromptModel.create({
        agentId: agent.id,
        promptId: prompt1.id,
        order: 0,
      });

      await AgentPromptModel.create({
        agentId: agent.id,
        promptId: prompt3.id,
        order: 1,
      });

      const agentPrompts = await AgentPromptModel.findByAgentId(agent.id);

      expect(agentPrompts).toHaveLength(3);
      // Should be ordered by order field: 0, 1, 2
      expect(agentPrompts[0].promptId).toBe(prompt1.id);
      expect(agentPrompts[0].order).toBe(0);
      expect(agentPrompts[1].promptId).toBe(prompt3.id);
      expect(agentPrompts[1].order).toBe(1);
      expect(agentPrompts[2].promptId).toBe(prompt2.id);
      expect(agentPrompts[2].order).toBe(2);
    });

    test("returns empty array when agent has no prompts", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();

      const agentPrompts = await AgentPromptModel.findByAgentId(agent.id);

      expect(agentPrompts).toEqual([]);
    });

    test("only returns prompts for specified agent", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent1 = await makeAgent({ name: "Agent 1" });
      const agent2 = await makeAgent({ name: "Agent 2" });

      const prompt1 = await PromptModel.create(org.id, user.id, {
        name: "Prompt for Agent 1",
        type: "system",
        content: "Agent 1 content",
      });

      const prompt2 = await PromptModel.create(org.id, user.id, {
        name: "Prompt for Agent 2",
        type: "system",
        content: "Agent 2 content",
      });

      // Assign prompts to different agents
      await AgentPromptModel.create({
        agentId: agent1.id,
        promptId: prompt1.id,
        order: 0,
      });

      await AgentPromptModel.create({
        agentId: agent2.id,
        promptId: prompt2.id,
        order: 0,
      });

      const agent1Prompts = await AgentPromptModel.findByAgentId(agent1.id);
      const agent2Prompts = await AgentPromptModel.findByAgentId(agent2.id);

      expect(agent1Prompts).toHaveLength(1);
      expect(agent1Prompts[0].promptId).toBe(prompt1.id);

      expect(agent2Prompts).toHaveLength(1);
      expect(agent2Prompts[0].promptId).toBe(prompt2.id);
    });
  });

  describe("findByAgentIdWithPrompts", () => {
    test("returns agent prompts with full prompt details", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent();

      const prompt = await PromptModel.create(org.id, user.id, {
        name: "Test Prompt",
        type: "system",
        content: "You are a helpful assistant.",
      });

      await AgentPromptModel.create({
        agentId: agent.id,
        promptId: prompt.id,
        order: 1,
      });

      const agentPromptsWithDetails =
        await AgentPromptModel.findByAgentIdWithPrompts(agent.id);

      expect(agentPromptsWithDetails).toHaveLength(1);

      const agentPrompt = agentPromptsWithDetails[0];
      expect(agentPrompt.agentId).toBe(agent.id);
      expect(agentPrompt.promptId).toBe(prompt.id);
      expect(agentPrompt.order).toBe(1);

      // Check prompt details
      expect(agentPrompt.prompt.id).toBe(prompt.id);
      expect(agentPrompt.prompt.name).toBe("Test Prompt");
      expect(agentPrompt.prompt.type).toBe("system");
      expect(agentPrompt.prompt.content).toBe("You are a helpful assistant.");
      expect(agentPrompt.prompt.version).toBe(1);
      expect(agentPrompt.prompt.isActive).toBe(true);
      expect(agentPrompt.prompt.organizationId).toBe(org.id);
      expect(agentPrompt.prompt.createdBy).toBe(user.id);
    });

    test("returns results ordered by order field", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent();

      const prompt1 = await PromptModel.create(org.id, user.id, {
        name: "High Priority",
        type: "system",
        content: "High priority prompt",
      });

      const prompt2 = await PromptModel.create(org.id, user.id, {
        name: "Low Priority",
        type: "regular",
        content: "Low priority prompt",
      });

      // Create in reverse order
      await AgentPromptModel.create({
        agentId: agent.id,
        promptId: prompt2.id,
        order: 5,
      });

      await AgentPromptModel.create({
        agentId: agent.id,
        promptId: prompt1.id,
        order: 1,
      });

      const agentPromptsWithDetails =
        await AgentPromptModel.findByAgentIdWithPrompts(agent.id);

      expect(agentPromptsWithDetails).toHaveLength(2);
      expect(agentPromptsWithDetails[0].prompt.name).toBe("High Priority");
      expect(agentPromptsWithDetails[0].order).toBe(1);
      expect(agentPromptsWithDetails[1].prompt.name).toBe("Low Priority");
      expect(agentPromptsWithDetails[1].order).toBe(5);
    });

    test("returns empty array when agent has no prompts", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();

      const result = await AgentPromptModel.findByAgentIdWithPrompts(agent.id);

      expect(result).toEqual([]);
    });
  });

  describe("delete", () => {
    test("deletes specific agent-prompt relationship", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent();

      const prompt = await PromptModel.create(org.id, user.id, {
        name: "Test Prompt",
        type: "system",
        content: "You are a helpful assistant.",
      });

      await AgentPromptModel.create({
        agentId: agent.id,
        promptId: prompt.id,
        order: 0,
      });

      // Verify relationship exists
      const beforeDelete = await AgentPromptModel.findByAgentId(agent.id);
      expect(beforeDelete).toHaveLength(1);

      await AgentPromptModel.delete(agent.id, prompt.id);

      // Verify relationship is deleted
      const afterDelete = await AgentPromptModel.findByAgentId(agent.id);
      expect(afterDelete).toEqual([]);
    });

    test("returns false when trying to delete non-existent relationship", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent();

      const prompt = await PromptModel.create(org.id, user.id, {
        name: "Test Prompt",
        type: "system",
        content: "You are a helpful assistant.",
      });

      const deleteResult = await AgentPromptModel.delete(agent.id, prompt.id);
      expect(deleteResult).toBe(false);
    });

    test("only deletes specified agent-prompt pair", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent();

      const prompt1 = await PromptModel.create(org.id, user.id, {
        name: "Prompt 1",
        type: "system",
        content: "First prompt",
      });

      const prompt2 = await PromptModel.create(org.id, user.id, {
        name: "Prompt 2",
        type: "regular",
        content: "Second prompt",
      });

      // Create multiple relationships
      await AgentPromptModel.create({
        agentId: agent.id,
        promptId: prompt1.id,
        order: 0,
      });

      await AgentPromptModel.create({
        agentId: agent.id,
        promptId: prompt2.id,
        order: 1,
      });

      // Delete only one relationship
      await AgentPromptModel.delete(agent.id, prompt1.id);

      // Verify only one relationship remains
      const remainingPrompts = await AgentPromptModel.findByAgentId(agent.id);
      expect(remainingPrompts).toHaveLength(1);
      expect(remainingPrompts[0].promptId).toBe(prompt2.id);
    });
  });

  describe("deleteAllByAgentId", () => {
    test("deletes all prompts from an agent", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent();

      const prompt1 = await PromptModel.create(org.id, user.id, {
        name: "Prompt 1",
        type: "system",
        content: "First prompt",
      });

      const prompt2 = await PromptModel.create(org.id, user.id, {
        name: "Prompt 2",
        type: "regular",
        content: "Second prompt",
      });

      // Create multiple relationships
      await AgentPromptModel.create({
        agentId: agent.id,
        promptId: prompt1.id,
        order: 0,
      });

      await AgentPromptModel.create({
        agentId: agent.id,
        promptId: prompt2.id,
        order: 1,
      });

      // Verify relationships exist
      const beforeDelete = await AgentPromptModel.findByAgentId(agent.id);
      expect(beforeDelete).toHaveLength(2);

      await AgentPromptModel.deleteAllByAgentId(agent.id);

      // Verify all relationships are deleted
      const afterDelete = await AgentPromptModel.findByAgentId(agent.id);
      expect(afterDelete).toEqual([]);
    });

    test("returns false when agent has no prompts to delete", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent();

      const deleteResult = await AgentPromptModel.deleteAllByAgentId(agent.id);
      expect(deleteResult).toBe(false);
    });

    test("only deletes prompts for specified agent", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent1 = await makeAgent({ name: "Agent 1" });
      const agent2 = await makeAgent({ name: "Agent 2" });

      const prompt = await PromptModel.create(org.id, user.id, {
        name: "Shared Prompt",
        type: "system",
        content: "Shared content",
      });

      // Assign same prompt to both agents
      await AgentPromptModel.create({
        agentId: agent1.id,
        promptId: prompt.id,
        order: 0,
      });

      await AgentPromptModel.create({
        agentId: agent2.id,
        promptId: prompt.id,
        order: 0,
      });

      // Delete all prompts from agent1
      await AgentPromptModel.deleteAllByAgentId(agent1.id);

      // Verify agent1 has no prompts
      const agent1Prompts = await AgentPromptModel.findByAgentId(agent1.id);
      expect(agent1Prompts).toEqual([]);

      // Verify agent2 still has the prompt
      const agent2Prompts = await AgentPromptModel.findByAgentId(agent2.id);
      expect(agent2Prompts).toHaveLength(1);
      expect(agent2Prompts[0].promptId).toBe(prompt.id);
    });
  });

  describe("replacePrompts", () => {
    test("replaces all prompts with system prompt only", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent();

      // Create existing prompts
      const oldPrompt = await PromptModel.create(org.id, user.id, {
        name: "Old Prompt",
        type: "regular",
        content: "Old content",
      });

      await AgentPromptModel.create({
        agentId: agent.id,
        promptId: oldPrompt.id,
        order: 0,
      });

      // Create new system prompt
      const systemPrompt = await PromptModel.create(org.id, user.id, {
        name: "System Prompt",
        type: "system",
        content: "You are a helpful assistant.",
      });

      const input: AssignAgentPrompts = {
        systemPromptId: systemPrompt.id,
        regularPromptIds: undefined,
      };

      const newAgentPrompts = await AgentPromptModel.replacePrompts(
        agent.id,
        input,
      );

      expect(newAgentPrompts).toHaveLength(1);
      expect(newAgentPrompts[0].promptId).toBe(systemPrompt.id);
      expect(newAgentPrompts[0].order).toBe(0);

      // Verify old prompts are gone
      const allPrompts = await AgentPromptModel.findByAgentId(agent.id);
      expect(allPrompts).toHaveLength(1);
      expect(allPrompts[0].promptId).toBe(systemPrompt.id);
    });

    test("replaces all prompts with regular prompts only", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent();

      // Create new regular prompts
      const regularPrompt1 = await PromptModel.create(org.id, user.id, {
        name: "Regular Prompt 1",
        type: "regular",
        content: "First regular content",
      });

      const regularPrompt2 = await PromptModel.create(org.id, user.id, {
        name: "Regular Prompt 2",
        type: "regular",
        content: "Second regular content",
      });

      const input: AssignAgentPrompts = {
        systemPromptId: null,
        regularPromptIds: [regularPrompt1.id, regularPrompt2.id],
      };

      const newAgentPrompts = await AgentPromptModel.replacePrompts(
        agent.id,
        input,
      );

      expect(newAgentPrompts).toHaveLength(2);

      // Regular prompts start at order 1 (0 is reserved for system prompt)
      expect(newAgentPrompts[0].promptId).toBe(regularPrompt1.id);
      expect(newAgentPrompts[0].order).toBe(1);
      expect(newAgentPrompts[1].promptId).toBe(regularPrompt2.id);
      expect(newAgentPrompts[1].order).toBe(2);
    });

    test("replaces all prompts with both system and regular prompts", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent();

      // Create system prompt
      const systemPrompt = await PromptModel.create(org.id, user.id, {
        name: "System Prompt",
        type: "system",
        content: "You are a helpful assistant.",
      });

      // Create regular prompts
      const regularPrompt1 = await PromptModel.create(org.id, user.id, {
        name: "Regular Prompt 1",
        type: "regular",
        content: "First regular content",
      });

      const regularPrompt2 = await PromptModel.create(org.id, user.id, {
        name: "Regular Prompt 2",
        type: "regular",
        content: "Second regular content",
      });

      const input: AssignAgentPrompts = {
        systemPromptId: systemPrompt.id,
        regularPromptIds: [regularPrompt1.id, regularPrompt2.id],
      };

      const newAgentPrompts = await AgentPromptModel.replacePrompts(
        agent.id,
        input,
      );

      expect(newAgentPrompts).toHaveLength(3);

      // System prompt should be at order 0
      expect(newAgentPrompts[0].promptId).toBe(systemPrompt.id);
      expect(newAgentPrompts[0].order).toBe(0);

      // Regular prompts should be at order 1, 2
      expect(newAgentPrompts[1].promptId).toBe(regularPrompt1.id);
      expect(newAgentPrompts[1].order).toBe(1);
      expect(newAgentPrompts[2].promptId).toBe(regularPrompt2.id);
      expect(newAgentPrompts[2].order).toBe(2);

      // Verify in database
      const allPrompts = await AgentPromptModel.findByAgentId(agent.id);
      expect(allPrompts).toHaveLength(3);
      // Should be ordered by order field
      expect(allPrompts.map((p) => p.order)).toEqual([0, 1, 2]);
    });

    test("replaces all prompts with empty configuration", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent();

      // Create existing prompts
      const existingPrompt = await PromptModel.create(org.id, user.id, {
        name: "Existing Prompt",
        type: "system",
        content: "Existing content",
      });

      await AgentPromptModel.create({
        agentId: agent.id,
        promptId: existingPrompt.id,
        order: 0,
      });

      const input: AssignAgentPrompts = {
        systemPromptId: null,
        regularPromptIds: [],
      };

      const newAgentPrompts = await AgentPromptModel.replacePrompts(
        agent.id,
        input,
      );

      expect(newAgentPrompts).toEqual([]);

      // Verify all prompts are removed
      const allPrompts = await AgentPromptModel.findByAgentId(agent.id);
      expect(allPrompts).toEqual([]);
    });

    test("deletes existing prompts before adding new ones", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent();

      // Create existing prompts
      const existingPrompt1 = await PromptModel.create(org.id, user.id, {
        name: "Existing Prompt 1",
        type: "system",
        content: "Existing content 1",
      });

      const existingPrompt2 = await PromptModel.create(org.id, user.id, {
        name: "Existing Prompt 2",
        type: "regular",
        content: "Existing content 2",
      });

      await AgentPromptModel.create({
        agentId: agent.id,
        promptId: existingPrompt1.id,
        order: 0,
      });

      await AgentPromptModel.create({
        agentId: agent.id,
        promptId: existingPrompt2.id,
        order: 1,
      });

      // Create new prompt
      const newPrompt = await PromptModel.create(org.id, user.id, {
        name: "New Prompt",
        type: "system",
        content: "New content",
      });

      const input: AssignAgentPrompts = {
        systemPromptId: newPrompt.id,
        regularPromptIds: [],
      };

      const newAgentPrompts = await AgentPromptModel.replacePrompts(
        agent.id,
        input,
      );

      expect(newAgentPrompts).toHaveLength(1);
      expect(newAgentPrompts[0].promptId).toBe(newPrompt.id);

      // Verify existing prompts are completely replaced
      const allPrompts = await AgentPromptModel.findByAgentId(agent.id);
      expect(allPrompts).toHaveLength(1);
      expect(allPrompts[0].promptId).toBe(newPrompt.id);

      // Verify existing prompts are not assigned to any other relationships
      const existingRelations = await db
        .select()
        .from(schema.agentPromptsTable)
        .where(
          and(
            eq(schema.agentPromptsTable.promptId, existingPrompt1.id),
            eq(schema.agentPromptsTable.agentId, agent.id),
          ),
        );
      expect(existingRelations).toEqual([]);
    });

    test("preserves order when regular prompt array is ordered", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent();

      const promptA = await PromptModel.create(org.id, user.id, {
        name: "Prompt A",
        type: "regular",
        content: "Content A",
      });

      const promptB = await PromptModel.create(org.id, user.id, {
        name: "Prompt B",
        type: "regular",
        content: "Content B",
      });

      const promptC = await PromptModel.create(org.id, user.id, {
        name: "Prompt C",
        type: "regular",
        content: "Content C",
      });

      const input: AssignAgentPrompts = {
        systemPromptId: null,
        regularPromptIds: [promptC.id, promptA.id, promptB.id], // Intentionally out of alphabetical order
      };

      const newAgentPrompts = await AgentPromptModel.replacePrompts(
        agent.id,
        input,
      );

      expect(newAgentPrompts).toHaveLength(3);

      // Should maintain input order
      expect(newAgentPrompts[0].promptId).toBe(promptC.id);
      expect(newAgentPrompts[0].order).toBe(1);
      expect(newAgentPrompts[1].promptId).toBe(promptA.id);
      expect(newAgentPrompts[1].order).toBe(2);
      expect(newAgentPrompts[2].promptId).toBe(promptB.id);
      expect(newAgentPrompts[2].order).toBe(3);
    });
  });
});
