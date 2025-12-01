import { and, desc, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertPrompt, Prompt, UpdatePrompt } from "@/types";

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
    input: InsertPrompt,
  ): Promise<Prompt> {
    const [prompt] = await db
      .insert(schema.promptsTable)
      .values({
        organizationId,
        name: input.name,
        agentId: input.agentId,
        userPrompt: input.userPrompt || null,
        systemPrompt: input.systemPrompt || null,
        version: 1,
        parentPromptId: null,
        isActive: true,
      })
      .returning();

    return prompt;
  }

  /**
   * Find all active prompts for an organization (latest versions only)
   */
  static async findByOrganizationId(organizationId: string): Promise<Prompt[]> {
    const prompts = await db
      .select()
      .from(schema.promptsTable)
      .where(
        and(
          eq(schema.promptsTable.organizationId, organizationId),
          eq(schema.promptsTable.isActive, true),
        ),
      )
      .orderBy(desc(schema.promptsTable.createdAt));

    return prompts;
  }

  /**
   * Find all active prompts for an organization filtered by accessible agent IDs
   * Returns only prompts assigned to agents the user has access to
   */
  static async findByOrganizationIdAndAccessibleAgents(
    organizationId: string,
    accessibleAgentIds: string[],
  ): Promise<Prompt[]> {
    // Return empty if no accessible agents
    if (accessibleAgentIds.length === 0) {
      return [];
    }

    const prompts = await db
      .select()
      .from(schema.promptsTable)
      .where(
        and(
          eq(schema.promptsTable.organizationId, organizationId),
          eq(schema.promptsTable.isActive, true),
          inArray(schema.promptsTable.agentId, accessibleAgentIds),
        ),
      )
      .orderBy(desc(schema.promptsTable.createdAt));

    return prompts;
  }

  /**
   * Find all active prompts for a specific agent (latest versions only)
   */
  static async findByAgentId(agentId: string): Promise<Prompt[]> {
    const prompts = await db
      .select()
      .from(schema.promptsTable)
      .where(
        and(
          eq(schema.promptsTable.agentId, agentId),
          eq(schema.promptsTable.isActive, true),
        ),
      )
      .orderBy(desc(schema.promptsTable.createdAt));

    return prompts;
  }

  /**
   * Find a prompt by ID
   */
  static async findById(id?: string | null): Promise<Prompt | null> {
    if (!id) {
      return null;
    }
    const [prompt] = await db
      .select()
      .from(schema.promptsTable)
      .where(eq(schema.promptsTable.id, id));

    return prompt || null;
  }

  /**
   * Find a prompt by ID and organization ID
   */
  static async findByIdAndOrganizationId(
    id: string,
    organizationId: string,
  ): Promise<Prompt | null> {
    const [prompt] = await db
      .select()
      .from(schema.promptsTable)
      .where(
        and(
          eq(schema.promptsTable.id, id),
          eq(schema.promptsTable.organizationId, organizationId),
        ),
      );

    return prompt || null;
  }

  /**
   * Get all versions of a prompt
   */
  static async findVersions(promptId: string): Promise<Prompt[]> {
    const currentPrompt = await PromptModel.findById(promptId);
    if (!currentPrompt) {
      return [];
    }

    // Get all versions (same name and agent)
    const versions = await db
      .select()
      .from(schema.promptsTable)
      .where(
        and(
          eq(schema.promptsTable.organizationId, currentPrompt.organizationId),
          eq(schema.promptsTable.name, currentPrompt.name),
          eq(schema.promptsTable.agentId, currentPrompt.agentId),
        ),
      )
      .orderBy(desc(schema.promptsTable.version));

    return versions;
  }

  /**
   * Update a prompt - creates a new version
   * Finds the most recent version (by version number) and creates a new version with incremented version number
   * Deactivates the currently active version
   * If name is changed, updates all versions to use the new name
   */
  static async update(id: string, input: UpdatePrompt): Promise<Prompt | null> {
    // Find the prompt by ID to get the prompt family (name, agentId, organizationId)
    const promptById = await PromptModel.findById(id);
    if (!promptById) {
      return null;
    }

    // Determine the name to use (new name if provided, otherwise keep current)
    const newName = input.name ?? promptById.name;
    const oldName = promptById.name;
    const nameChanged = input.name !== undefined && input.name !== oldName;

    // Determine the agentId to use (new agentId if provided, otherwise keep current)
    const newAgentId = input.agentId || promptById.agentId;
    const oldAgentId = promptById.agentId;
    const agentChanged =
      input.agentId !== undefined && input.agentId !== oldAgentId;

    // If name or agentId is being changed, update all versions to use the new values
    if (nameChanged || agentChanged) {
      const updateValues: { name?: string; agentId?: string } = {};
      if (nameChanged) updateValues.name = newName;
      if (agentChanged) updateValues.agentId = newAgentId;

      await db
        .update(schema.promptsTable)
        .set(updateValues)
        .where(
          and(
            eq(schema.promptsTable.organizationId, promptById.organizationId),
            eq(schema.promptsTable.name, oldName),
            eq(schema.promptsTable.agentId, oldAgentId),
          ),
        );
    }

    // Find the MOST RECENT version (highest version number) for this prompt family
    // This ensures we always increment from the latest version number,
    // regardless of which version is active
    // Use the new name and agentId for finding versions
    const [latestVersion] = await db
      .select()
      .from(schema.promptsTable)
      .where(
        and(
          eq(schema.promptsTable.organizationId, promptById.organizationId),
          eq(schema.promptsTable.name, newName),
          eq(schema.promptsTable.agentId, newAgentId),
        ),
      )
      .orderBy(desc(schema.promptsTable.version))
      .limit(1);

    if (!latestVersion) {
      return null;
    }

    // Find and deactivate the currently active version (if any)
    await db
      .update(schema.promptsTable)
      .set({ isActive: false })
      .where(
        and(
          eq(schema.promptsTable.organizationId, promptById.organizationId),
          eq(schema.promptsTable.name, newName),
          eq(schema.promptsTable.agentId, newAgentId),
          eq(schema.promptsTable.isActive, true),
        ),
      );

    // Create new version
    // Use the input values, falling back to latest version's values
    const [newVersion] = await db
      .insert(schema.promptsTable)
      .values({
        organizationId: latestVersion.organizationId,
        name: newName,
        agentId: newAgentId,
        userPrompt: input.userPrompt ?? latestVersion.userPrompt,
        systemPrompt: input.systemPrompt ?? latestVersion.systemPrompt,
        version: latestVersion.version + 1,
        parentPromptId: latestVersion.id,
        isActive: true,
      })
      .returning();

    return newVersion;
  }

  /**
   * Rollback to a specific version
   * Deactivates all versions and activates the target version
   */
  static async rollback(
    id: string,
    targetVersionId: string,
  ): Promise<Prompt | null> {
    const currentPrompt = await PromptModel.findById(id);
    const targetPrompt = await PromptModel.findById(targetVersionId);

    if (!currentPrompt || !targetPrompt) {
      return null;
    }

    // Verify target version belongs to same prompt family
    if (
      currentPrompt.name !== targetPrompt.name ||
      currentPrompt.agentId !== targetPrompt.agentId ||
      currentPrompt.organizationId !== targetPrompt.organizationId
    ) {
      return null;
    }

    // Deactivate all versions
    await db
      .update(schema.promptsTable)
      .set({ isActive: false })
      .where(
        and(
          eq(schema.promptsTable.organizationId, currentPrompt.organizationId),
          eq(schema.promptsTable.name, currentPrompt.name),
          eq(schema.promptsTable.agentId, currentPrompt.agentId),
        ),
      );

    // Activate target version
    const [activated] = await db
      .update(schema.promptsTable)
      .set({ isActive: true })
      .where(eq(schema.promptsTable.id, targetVersionId))
      .returning();

    return activated || null;
  }

  /**
   * Delete a prompt (and all its versions)
   */
  static async delete(id: string): Promise<boolean> {
    const prompt = await PromptModel.findById(id);
    if (!prompt) {
      return false;
    }

    // Get all versions
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
