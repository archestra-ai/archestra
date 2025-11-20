import { and, desc, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertPrompt,
  PromptType,
  PromptWithAgents,
  UpdatePrompt,
} from "@/types";

/**
 * Model for managing prompts with versioning support
 * Provides CRUD operations and version management
 */
class PromptModel {
  /**
   * Create a new prompt
   */
  static async create(
    organizationId: string,
    createdBy: string,
    input: InsertPrompt,
  ): Promise<PromptWithAgents> {
    const [prompt] = await db
      .insert(schema.promptsTable)
      .values({
        organizationId,
        name: input.name,
        type: input.type,
        content: input.content,
        version: 1,
        parentPromptId: null,
        isActive: true,
        createdBy,
      })
      .returning();

    return {
      ...prompt,
      agents: [],
    };
  }

  static getAgentsForPrompt(
    promptId: string,
  ): Promise<PromptWithAgents["agents"]> {
    return db
      .select({
        id: schema.agentsTable.id,
        name: schema.agentsTable.name,
      })
      .from(schema.agentPromptsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.agentPromptsTable.agentId, schema.agentsTable.id),
      )
      .where(eq(schema.agentPromptsTable.promptId, promptId))
      .orderBy(schema.agentsTable.name);
  }

  /**
   * Batch-load agents for multiple prompts to avoid N+1 queries
   */
  private static async getAgentsForPrompts(
    promptIds: string[],
  ): Promise<Map<string, PromptWithAgents["agents"]>> {
    if (promptIds.length === 0) {
      return new Map();
    }

    const assignments = await db
      .select({
        promptId: schema.agentPromptsTable.promptId,
        agentId: schema.agentsTable.id,
        agentName: schema.agentsTable.name,
      })
      .from(schema.agentPromptsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.agentPromptsTable.agentId, schema.agentsTable.id),
      )
      .where(inArray(schema.agentPromptsTable.promptId, promptIds))
      .orderBy(schema.agentPromptsTable.promptId, schema.agentsTable.name);

    const agentMap = new Map<string, PromptWithAgents["agents"]>();

    for (const assignment of assignments) {
      const agents = agentMap.get(assignment.promptId) ?? [];
      agents.push({
        id: assignment.agentId,
        name: assignment.agentName,
      });
      agentMap.set(assignment.promptId, agents);
    }

    return agentMap;
  }

  /**
   * Find all prompts for an organization
   * Returns only active (latest) versions with agent information
   */
  static async findByOrganizationId(
    organizationId: string,
    type?: PromptType,
  ): Promise<PromptWithAgents[]> {
    const baseConditions = [
      eq(schema.promptsTable.organizationId, organizationId),
      eq(schema.promptsTable.isActive, true),
    ];

    if (type) {
      baseConditions.push(eq(schema.promptsTable.type, type));
    }

    const prompts = await db
      .select()
      .from(schema.promptsTable)
      .where(and(...baseConditions))
      .orderBy(desc(schema.promptsTable.createdAt));

    const agentMap = await PromptModel.getAgentsForPrompts(
      prompts.map((prompt) => prompt.id),
    );

    return prompts.map((prompt) => ({
      ...prompt,
      agents: agentMap.get(prompt.id) ?? [],
    }));
  }

  /**
   * Find a prompt by ID
   */
  static async findById(id: string): Promise<PromptWithAgents | null> {
    const [prompt] = await db
      .select()
      .from(schema.promptsTable)
      .where(eq(schema.promptsTable.id, id));

    if (!prompt) {
      return null;
    }

    return {
      ...prompt,
      agents: await PromptModel.getAgentsForPrompt(prompt.id),
    };
  }

  /**
   * Get all versions of a prompt (finds the root prompt and all its descendants)
   */
  static async findVersions(promptId: string): Promise<PromptWithAgents[]> {
    const currentPrompt = await PromptModel.findById(promptId);
    if (!currentPrompt) {
      return [];
    }

    // Get all versions (same name, type, and organization)
    const versions = await db
      .select()
      .from(schema.promptsTable)
      .where(
        and(
          eq(schema.promptsTable.organizationId, currentPrompt.organizationId),
          eq(schema.promptsTable.name, currentPrompt.name),
          eq(schema.promptsTable.type, currentPrompt.type),
        ),
      )
      .orderBy(schema.promptsTable.version);

    const agentMap = await PromptModel.getAgentsForPrompts(
      versions.map((version) => version.id),
    );

    return versions.map((version) => ({
      ...version,
      agents: agentMap.get(version.id) ?? [],
    }));
  }

  /**
   * Update a prompt - creates a new version
   * Deactivates the old version and creates a new active version
   * Migrates agent-prompt relationships to the new version
   */
  static async update(
    id: string,
    createdBy: string,
    input: UpdatePrompt,
  ): Promise<PromptWithAgents | null> {
    const currentPrompt = await PromptModel.findById(id);
    if (!currentPrompt) {
      return null;
    }

    // Get existing agent-prompt relationships before deactivating
    const existingRelationships = await db
      .select()
      .from(schema.agentPromptsTable)
      .where(eq(schema.agentPromptsTable.promptId, id));

    // Deactivate current version
    await db
      .update(schema.promptsTable)
      .set({ isActive: false })
      .where(eq(schema.promptsTable.id, id));

    // Create new version
    const [newVersion] = await db
      .insert(schema.promptsTable)
      .values({
        organizationId: currentPrompt.organizationId,
        name: input.name || currentPrompt.name,
        type: currentPrompt.type,
        content: input.content || currentPrompt.content,
        version: currentPrompt.version + 1,
        parentPromptId: id,
        isActive: true,
        createdBy,
      })
      .returning();

    // Migrate agent-prompt relationships to the new version
    if (existingRelationships.length > 0) {
      // Update existing relationships to point to the new prompt version
      await db
        .update(schema.agentPromptsTable)
        .set({ promptId: newVersion.id })
        .where(eq(schema.agentPromptsTable.promptId, id));
    }

    return {
      ...newVersion,
      agents: await PromptModel.getAgentsForPrompt(newVersion.id),
    };
  }

  /**
   * Delete a prompt (and all its versions)
   * This will cascade delete agent_prompt relationships
   */
  static async delete(id: string): Promise<boolean> {
    const prompt = await PromptModel.findById(id);
    if (!prompt) {
      return false;
    }

    // Find all versions of this prompt
    const versions = await PromptModel.findVersions(id);
    const versionIds = versions.map((v) => v.id);

    // Delete all versions
    for (const versionId of versionIds) {
      await db
        .delete(schema.promptsTable)
        .where(eq(schema.promptsTable.id, versionId));
    }

    return true;
  }
}

export default PromptModel;
