import { and, desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertPrompt, Prompt, UpdatePrompt } from "@/types";

/**
 * Model for managing prompts
 * Provides CRUD operations for prompts with direct agent relationships
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
      })
      .returning();

    return prompt;
  }

  /**
   * Find all prompts for an organization
   */
  static async findByOrganizationId(organizationId: string): Promise<Prompt[]> {
    const prompts = await db
      .select()
      .from(schema.promptsTable)
      .where(eq(schema.promptsTable.organizationId, organizationId))
      .orderBy(desc(schema.promptsTable.createdAt));

    return prompts;
  }

  /**
   * Find all prompts for a specific agent
   */
  static async findByAgentId(agentId: string): Promise<Prompt[]> {
    const prompts = await db
      .select()
      .from(schema.promptsTable)
      .where(eq(schema.promptsTable.agentId, agentId))
      .orderBy(desc(schema.promptsTable.createdAt));

    return prompts;
  }

  /**
   * Find a prompt by ID
   */
  static async findById(id: string): Promise<Prompt | null> {
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
   * Update a prompt
   */
  static async update(id: string, input: UpdatePrompt): Promise<Prompt | null> {
    const [updatedPrompt] = await db
      .update(schema.promptsTable)
      .set({
        name: input.name,
        userPrompt: input.userPrompt,
        systemPrompt: input.systemPrompt,
      })
      .where(eq(schema.promptsTable.id, id))
      .returning();

    return updatedPrompt || null;
  }

  /**
   * Delete a prompt
   */
  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.promptsTable)
      .where(eq(schema.promptsTable.id, id))
      .returning();

    return result.length > 0;
  }
}

export default PromptModel;
