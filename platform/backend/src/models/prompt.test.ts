import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import type { InsertPrompt, UpdatePrompt } from "@/types";
import PromptModel from "./prompt";

describe("PromptModel", () => {
  describe("create", () => {
    test("creates a new prompt with default values", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();

      const promptData: InsertPrompt = {
        name: "Test Prompt",
        type: "system",
        content: "You are a helpful assistant.",
      };

      const prompt = await PromptModel.create(org.id, user.id, promptData);

      expect(prompt.id).toBeDefined();
      expect(prompt.name).toBe(promptData.name);
      expect(prompt.type).toBe(promptData.type);
      expect(prompt.content).toBe(promptData.content);
      expect(prompt.version).toBe(1);
      expect(prompt.parentPromptId).toBeNull();
      expect(prompt.isActive).toBe(true);
      expect(prompt.organizationId).toBe(org.id);
      expect(prompt.createdBy).toBe(user.id);
      expect(prompt.agents).toEqual([]);
      expect(prompt.createdAt).toBeInstanceOf(Date);
      expect(prompt.updatedAt).toBeInstanceOf(Date);
    });

    test("creates prompt with regular type", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();

      const promptData: InsertPrompt = {
        name: "Regular Prompt",
        type: "regular",
        content: "This is a regular prompt.",
      };

      const prompt = await PromptModel.create(org.id, user.id, promptData);

      expect(prompt.type).toBe("regular");
      expect(prompt.name).toBe("Regular Prompt");
    });
  });

  describe("findById", () => {
    test("finds an existing prompt by ID", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();

      const created = await PromptModel.create(org.id, user.id, {
        name: "Find Me",
        type: "system",
        content: "Find me prompt content",
      });

      const found = await PromptModel.findById(created.id);

      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.name).toBe(created.name);
      expect(found?.agents).toEqual([]);
    });

    test("returns null for non-existent prompt", async () => {
      const result = await PromptModel.findById(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(result).toBeNull();
    });

    test("includes agent relationships", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent();

      const prompt = await PromptModel.create(org.id, user.id, {
        name: "Prompt with Agent",
        type: "system",
        content: "Content",
      });

      // Create agent-prompt relationship
      await db.insert(schema.agentPromptsTable).values({
        agentId: agent.id,
        promptId: prompt.id,
      });

      const found = await PromptModel.findById(prompt.id);

      expect(found?.agents).toHaveLength(1);
      expect(found?.agents[0].id).toBe(agent.id);
      expect(found?.agents[0].name).toBe(agent.name);
    });
  });

  describe("findByOrganizationId", () => {
    test("finds all active prompts for an organization", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      const org1 = await makeOrganization();
      const org2 = await makeOrganization();

      // Create prompts in org1
      await PromptModel.create(org1.id, user.id, {
        name: "Org1 Prompt 1",
        type: "system",
        content: "Content 1",
      });
      await PromptModel.create(org1.id, user.id, {
        name: "Org1 Prompt 2",
        type: "regular",
        content: "Content 2",
      });

      // Create prompt in org2 (should not be returned)
      await PromptModel.create(org2.id, user.id, {
        name: "Org2 Prompt",
        type: "system",
        content: "Content",
      });

      const prompts = await PromptModel.findByOrganizationId(org1.id);

      expect(prompts).toHaveLength(2);
      expect(prompts.every((p) => p.organizationId === org1.id)).toBe(true);
      expect(prompts.every((p) => p.isActive === true)).toBe(true);
      expect(prompts.map((p) => p.name)).toEqual(
        expect.arrayContaining(["Org1 Prompt 1", "Org1 Prompt 2"]),
      );
    });

    test("filters by prompt type", async ({ makeUser, makeOrganization }) => {
      const user = await makeUser();
      const org = await makeOrganization();

      await PromptModel.create(org.id, user.id, {
        name: "System Prompt",
        type: "system",
        content: "System content",
      });
      await PromptModel.create(org.id, user.id, {
        name: "Regular Prompt",
        type: "regular",
        content: "Regular content",
      });

      const systemPrompts = await PromptModel.findByOrganizationId(
        org.id,
        "system",
      );
      const regularPrompts = await PromptModel.findByOrganizationId(
        org.id,
        "regular",
      );

      expect(systemPrompts).toHaveLength(1);
      expect(systemPrompts[0].type).toBe("system");
      expect(systemPrompts[0].name).toBe("System Prompt");

      expect(regularPrompts).toHaveLength(1);
      expect(regularPrompts[0].type).toBe("regular");
      expect(regularPrompts[0].name).toBe("Regular Prompt");
    });

    test("excludes inactive prompts", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();

      const activePrompt = await PromptModel.create(org.id, user.id, {
        name: "Active Prompt",
        type: "system",
        content: "Active content",
      });

      // Manually create inactive prompt
      await db.insert(schema.promptsTable).values({
        organizationId: org.id,
        name: "Inactive Prompt",
        type: "system",
        content: "Inactive content",
        version: 1,
        isActive: false,
        createdBy: user.id,
      });

      const prompts = await PromptModel.findByOrganizationId(org.id);

      expect(prompts).toHaveLength(1);
      expect(prompts[0].id).toBe(activePrompt.id);
    });

    test("returns prompts ordered by creation date (newest first)", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();

      const prompt1 = await PromptModel.create(org.id, user.id, {
        name: "First Prompt",
        type: "system",
        content: "Content 1",
      });

      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));

      const prompt2 = await PromptModel.create(org.id, user.id, {
        name: "Second Prompt",
        type: "system",
        content: "Content 2",
      });

      const prompts = await PromptModel.findByOrganizationId(org.id);

      expect(prompts).toHaveLength(2);
      expect(prompts[0].id).toBe(prompt2.id); // Newest first
      expect(prompts[1].id).toBe(prompt1.id);
    });
  });

  describe("findVersions", () => {
    test("finds all versions of a prompt", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();

      const original = await PromptModel.create(org.id, user.id, {
        name: "Versioned Prompt",
        type: "system",
        content: "Version 1 content",
      });

      const updated = await PromptModel.update(original.id, user.id, {
        content: "Version 2 content",
      });

      expect(updated).not.toBeNull();

      const versions = await PromptModel.findVersions(original.id);

      expect(versions).toHaveLength(2);
      expect(versions[0].version).toBe(1);
      expect(versions[0].content).toBe("Version 1 content");
      expect(versions[0].isActive).toBe(false);
      expect(versions[1].version).toBe(2);
      expect(versions[1].content).toBe("Version 2 content");
      expect(versions[1].isActive).toBe(true);
    });

    test("returns empty array for non-existent prompt", async () => {
      const versions = await PromptModel.findVersions(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(versions).toEqual([]);
    });

    test("works with prompt ID from any version", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();

      const original = await PromptModel.create(org.id, user.id, {
        name: "Multi Version",
        type: "system",
        content: "V1",
      });

      const v2 = await PromptModel.update(original.id, user.id, {
        content: "V2",
      });

      if (!v2) {
        throw new Error("Failed to create v2 prompt");
      }

      const v3 = await PromptModel.update(v2.id, user.id, {
        content: "V3",
      });

      if (!v3) {
        throw new Error("Failed to create v3 prompt");
      }

      // Should return same versions regardless of which ID we use
      const versionsFromOriginal = await PromptModel.findVersions(original.id);
      const versionsFromV2 = await PromptModel.findVersions(v2.id);
      const versionsFromV3 = await PromptModel.findVersions(v3.id);

      expect(versionsFromOriginal).toHaveLength(3);
      expect(versionsFromV2).toHaveLength(3);
      expect(versionsFromV3).toHaveLength(3);

      // All should contain same version numbers
      [versionsFromOriginal, versionsFromV2, versionsFromV3].forEach(
        (versions) => {
          expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
        },
      );
    });
  });

  describe("update", () => {
    test("creates new version and deactivates old one", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();

      const original = await PromptModel.create(org.id, user.id, {
        name: "Original Prompt",
        type: "system",
        content: "Original content",
      });

      const updateData: UpdatePrompt = {
        name: "Updated Prompt",
        content: "Updated content",
      };

      const updated = await PromptModel.update(
        original.id,
        user.id,
        updateData,
      );

      expect(updated).not.toBeNull();
      expect(updated?.id).not.toBe(original.id);
      expect(updated?.name).toBe(updateData.name);
      expect(updated?.content).toBe(updateData.content);
      expect(updated?.type).toBe(original.type); // Type should remain same
      expect(updated?.version).toBe(2);
      expect(updated?.parentPromptId).toBe(original.id);
      expect(updated?.isActive).toBe(true);
      expect(updated?.organizationId).toBe(org.id);
      expect(updated?.createdBy).toBe(user.id);

      // Check original is deactivated
      const originalAfterUpdate = await PromptModel.findById(original.id);
      expect(originalAfterUpdate?.isActive).toBe(false);
    });

    test("partial update only changes specified fields", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();

      const original = await PromptModel.create(org.id, user.id, {
        name: "Original Name",
        type: "system",
        content: "Original content",
      });

      // Only update content, leave name unchanged
      const updated = await PromptModel.update(original.id, user.id, {
        content: "New content only",
      });

      expect(updated).not.toBeNull();
      expect(updated?.name).toBe(original.name); // Unchanged
      expect(updated?.content).toBe("New content only");
      expect(updated?.type).toBe(original.type);
    });

    test("returns null for non-existent prompt", async ({ makeUser }) => {
      const user = await makeUser();

      const result = await PromptModel.update(
        "00000000-0000-0000-0000-000000000000",
        user.id,
        {
          content: "New content",
        },
      );

      expect(result).toBeNull();
    });

    test("maintains agent relationships for new version", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent();

      const original = await PromptModel.create(org.id, user.id, {
        name: "Prompt with Agent",
        type: "system",
        content: "Original",
      });

      // Create agent relationship
      await db.insert(schema.agentPromptsTable).values({
        agentId: agent.id,
        promptId: original.id,
      });

      const updated = await PromptModel.update(original.id, user.id, {
        content: "Updated",
      });

      // New version should maintain the agent relationships
      expect(updated?.agents).toHaveLength(1);
      expect(updated?.agents[0].id).toBe(agent.id);
      expect(updated?.agents[0].name).toBe(agent.name);

      // Verify the old version no longer has relationships (migrated to new version)
      const originalWithAgents = await PromptModel.findById(original.id);
      expect(originalWithAgents?.agents).toHaveLength(0);
    });

    test("preserves agent-prompt order when creating new version", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent1 = await makeAgent({ name: "Agent 1" });
      const agent2 = await makeAgent({ name: "Agent 2" });
      const agent3 = await makeAgent({ name: "Agent 3" });

      const original = await PromptModel.create(org.id, user.id, {
        name: "Multi-Agent Prompt",
        type: "system",
        content: "Original",
      });

      // Create agent relationships with specific orders
      await db.insert(schema.agentPromptsTable).values([
        { agentId: agent1.id, promptId: original.id, order: 0 },
        { agentId: agent2.id, promptId: original.id, order: 1 },
        { agentId: agent3.id, promptId: original.id, order: 2 },
      ]);

      const updated = await PromptModel.update(original.id, user.id, {
        content: "Updated",
      });

      if (!updated) {
        throw new Error("Failed to update prompt");
      }

      // New version should maintain all agent relationships with same order
      expect(updated.agents).toHaveLength(3);

      // Verify order is preserved by checking the actual agent_prompts table
      const newVersionRelationships = await db
        .select()
        .from(schema.agentPromptsTable)
        .where(eq(schema.agentPromptsTable.promptId, updated.id))
        .orderBy(schema.agentPromptsTable.order);

      expect(newVersionRelationships).toHaveLength(3);
      expect(newVersionRelationships[0].agentId).toBe(agent1.id);
      expect(newVersionRelationships[0].order).toBe(0);
      expect(newVersionRelationships[1].agentId).toBe(agent2.id);
      expect(newVersionRelationships[1].order).toBe(1);
      expect(newVersionRelationships[2].agentId).toBe(agent3.id);
      expect(newVersionRelationships[2].order).toBe(2);
    });
  });

  describe("delete", () => {
    test("deletes all versions of a prompt", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();

      const original = await PromptModel.create(org.id, user.id, {
        name: "To Delete",
        type: "system",
        content: "Original",
      });

      const v2 = await PromptModel.update(original.id, user.id, {
        content: "Version 2",
      });

      if (!v2) {
        throw new Error("Failed to create v2 prompt");
      }

      const v3 = await PromptModel.update(v2.id, user.id, {
        content: "Version 3",
      });

      if (!v3) {
        throw new Error("Failed to create v3 prompt");
      }

      const deleteResult = await PromptModel.delete(original.id);
      expect(deleteResult).toBe(true);

      // All versions should be deleted
      expect(await PromptModel.findById(original.id)).toBeNull();
      expect(await PromptModel.findById(v2.id)).toBeNull();
      expect(await PromptModel.findById(v3.id)).toBeNull();

      // findVersions should return empty array
      expect(await PromptModel.findVersions(original.id)).toEqual([]);
    });

    test("can delete from any version ID", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();

      const original = await PromptModel.create(org.id, user.id, {
        name: "Delete from any version",
        type: "system",
        content: "V1",
      });

      const v2 = await PromptModel.update(original.id, user.id, {
        content: "V2",
      });

      if (!v2) {
        throw new Error("Failed to create v2 prompt");
      }

      // Delete using v2 ID instead of original
      const deleteResult = await PromptModel.delete(v2.id);
      expect(deleteResult).toBe(true);

      expect(await PromptModel.findById(original.id)).toBeNull();
      expect(await PromptModel.findById(v2.id)).toBeNull();
    });

    test("returns false for non-existent prompt", async () => {
      const result = await PromptModel.delete(
        "00000000-0000-0000-0000-000000000000",
      );
      expect(result).toBe(false);
    });

    test("cascades to agent-prompt relationships", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();
      const agent = await makeAgent();

      const prompt = await PromptModel.create(org.id, user.id, {
        name: "Prompt with relationships",
        type: "system",
        content: "Content",
      });

      // Create agent relationship
      await db.insert(schema.agentPromptsTable).values({
        agentId: agent.id,
        promptId: prompt.id,
      });

      // Verify relationship exists
      const beforeDelete = await db
        .select()
        .from(schema.agentPromptsTable)
        .where(eq(schema.agentPromptsTable.promptId, prompt.id));
      expect(beforeDelete).toHaveLength(1);

      await PromptModel.delete(prompt.id);

      // Verify relationship is deleted (should cascade)
      const afterDelete = await db
        .select()
        .from(schema.agentPromptsTable)
        .where(eq(schema.agentPromptsTable.promptId, prompt.id));
      expect(afterDelete).toHaveLength(0);
    });
  });

  describe("getAgentsForPrompt", () => {
    test("returns agents ordered by name", async ({
      makeUser,
      makeOrganization,
      makeAgent,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();

      // Create agents with specific names to test ordering
      const agentZ = await makeAgent({ name: "Z Agent" });
      const agentA = await makeAgent({ name: "A Agent" });
      const agentM = await makeAgent({ name: "M Agent" });

      const prompt = await PromptModel.create(org.id, user.id, {
        name: "Test Prompt",
        type: "system",
        content: "Content",
      });

      // Create relationships in random order
      await db.insert(schema.agentPromptsTable).values([
        { agentId: agentZ.id, promptId: prompt.id },
        { agentId: agentA.id, promptId: prompt.id },
        { agentId: agentM.id, promptId: prompt.id },
      ]);

      const agents = await PromptModel.getAgentsForPrompt(prompt.id);

      expect(agents).toHaveLength(3);
      expect(agents[0].name).toBe("A Agent");
      expect(agents[1].name).toBe("M Agent");
      expect(agents[2].name).toBe("Z Agent");
    });

    test("returns empty array when no agents are associated", async ({
      makeUser,
      makeOrganization,
    }) => {
      const user = await makeUser();
      const org = await makeOrganization();

      const prompt = await PromptModel.create(org.id, user.id, {
        name: "Lonely Prompt",
        type: "system",
        content: "No agents here",
      });

      const agents = await PromptModel.getAgentsForPrompt(prompt.id);
      expect(agents).toEqual([]);
    });
  });
});
