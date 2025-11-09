import { and, desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { PromptType } from "@/database/schemas/prompt";

export interface Prompt {
  id: string;
  organizationId: string;
  name: string;
  type: PromptType;
  content: string;
  version: number;
  parentPromptId: string | null;
  isActive: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePromptInput {
  organizationId: string;
  name: string;
  type: PromptType;
  content: string;
  createdBy: string;
}

export interface UpdatePromptInput {
  name?: string;
  content?: string;
  createdBy: string; // User who created the new version
}

/**
 * Model for managing prompts with versioning support
 * Provides CRUD operations and version management
 */
class PromptModel {
  /**
   * Create a new prompt
   */
  static async create(input: CreatePromptInput): Promise<Prompt> {
    const [prompt] = await db
      .insert(schema.promptsTable)
      .values({
        organizationId: input.organizationId,
        name: input.name,
        type: input.type,
        content: input.content,
        version: 1,
        parentPromptId: null,
        isActive: true,
        createdBy: input.createdBy,
      })
      .returning();

    return prompt as Prompt;
  }

  /**
   * Find all prompts for an organization
   * Returns only active (latest) versions with agent information
   */
  static async findByOrganizationId(
    organizationId: string,
    type?: PromptType,
  ): Promise<
    (Prompt & {
      agents: Array<{ id: string; name: string }>;
    })[]
  > {
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

    // For each prompt, fetch the agents that use it
    const promptsWithAgents = await Promise.all(
      prompts.map(async (prompt) => {
        const agents = await db
          .select({
            id: schema.agentsTable.id,
            name: schema.agentsTable.name,
          })
          .from(schema.agentPromptsTable)
          .innerJoin(
            schema.agentsTable,
            eq(schema.agentPromptsTable.agentId, schema.agentsTable.id),
          )
          .where(eq(schema.agentPromptsTable.promptId, prompt.id))
          .orderBy(schema.agentsTable.name);

        return {
          ...(prompt as Prompt),
          agents,
        };
      }),
    );

    return promptsWithAgents;
  }

  /**
   * Find a prompt by ID
   */
  static async findById(id: string): Promise<Prompt | null> {
    const [prompt] = await db
      .select()
      .from(schema.promptsTable)
      .where(eq(schema.promptsTable.id, id));

    return prompt ? (prompt as Prompt) : null;
  }

  /**
   * Get all versions of a prompt (finds the root prompt and all its descendants)
   */
  static async findVersions(promptId: string): Promise<Prompt[]> {
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

    return versions as Prompt[];
  }

  /**
   * Update a prompt - creates a new version
   * Deactivates the old version and creates a new active version
   */
  static async update(
    id: string,
    input: UpdatePromptInput,
  ): Promise<Prompt | null> {
    const currentPrompt = await PromptModel.findById(id);
    if (!currentPrompt) {
      return null;
    }

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
        createdBy: input.createdBy,
      })
      .returning();

    return newVersion as Prompt;
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

  /**
   * Get active prompts by IDs
   */
  static async findByIds(ids: string[]): Promise<Prompt[]> {
    if (ids.length === 0) {
      return [];
    }

    const prompts = await db
      .select()
      .from(schema.promptsTable)
      .where(
        and(
          eq(schema.promptsTable.isActive, true),
          // @ts-expect-error - inArray type issue
          db.inArray(schema.promptsTable.id, ids),
        ),
      );

    return prompts as Prompt[];
  }
}

export default PromptModel;
