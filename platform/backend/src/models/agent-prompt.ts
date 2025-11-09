import { and, asc, eq } from "drizzle-orm";
import db, { schema } from "@/database";

export interface AgentPrompt {
  id: string;
  agentId: string;
  promptId: string;
  order: number;
  createdAt: Date;
}

export interface CreateAgentPromptInput {
  agentId: string;
  promptId: string;
  order?: number;
}

export interface AssignPromptsInput {
  agentId: string;
  systemPromptId?: string | null;
  regularPromptIds?: string[];
}

/**
 * Model for managing agent-prompt relationships
 * Handles assigning prompts to agents
 */
class AgentPromptModel {
  /**
   * Assign a single prompt to an agent
   */
  static async create(input: CreateAgentPromptInput): Promise<AgentPrompt> {
    const [agentPrompt] = await db
      .insert(schema.agentPromptsTable)
      .values({
        agentId: input.agentId,
        promptId: input.promptId,
        order: input.order || 0,
      })
      .returning();

    return agentPrompt as AgentPrompt;
  }

  /**
   * Get all prompts assigned to an agent
   * Returns prompts ordered by the order field
   */
  static async findByAgentId(agentId: string): Promise<AgentPrompt[]> {
    const agentPrompts = await db
      .select()
      .from(schema.agentPromptsTable)
      .where(eq(schema.agentPromptsTable.agentId, agentId))
      .orderBy(asc(schema.agentPromptsTable.order));

    return agentPrompts as AgentPrompt[];
  }

  /**
   * Get all prompts assigned to an agent with full prompt details
   */
  static async findByAgentIdWithPrompts(agentId: string) {
    const agentPrompts = await db
      .select({
        id: schema.agentPromptsTable.id,
        agentId: schema.agentPromptsTable.agentId,
        promptId: schema.agentPromptsTable.promptId,
        order: schema.agentPromptsTable.order,
        createdAt: schema.agentPromptsTable.createdAt,
        prompt: {
          id: schema.promptsTable.id,
          organizationId: schema.promptsTable.organizationId,
          name: schema.promptsTable.name,
          type: schema.promptsTable.type,
          content: schema.promptsTable.content,
          version: schema.promptsTable.version,
          parentPromptId: schema.promptsTable.parentPromptId,
          isActive: schema.promptsTable.isActive,
          createdBy: schema.promptsTable.createdBy,
          createdAt: schema.promptsTable.createdAt,
          updatedAt: schema.promptsTable.updatedAt,
        },
      })
      .from(schema.agentPromptsTable)
      .innerJoin(
        schema.promptsTable,
        eq(schema.agentPromptsTable.promptId, schema.promptsTable.id),
      )
      .where(eq(schema.agentPromptsTable.agentId, agentId))
      .orderBy(asc(schema.agentPromptsTable.order));

    return agentPrompts;
  }

  /**
   * Remove a prompt from an agent
   */
  static async delete(agentId: string, promptId: string): Promise<boolean> {
    const result = await db
      .delete(schema.agentPromptsTable)
      .where(
        and(
          eq(schema.agentPromptsTable.agentId, agentId),
          eq(schema.agentPromptsTable.promptId, promptId),
        ),
      );

    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Remove all prompts from an agent
   */
  static async deleteAllByAgentId(agentId: string): Promise<boolean> {
    const result = await db
      .delete(schema.agentPromptsTable)
      .where(eq(schema.agentPromptsTable.agentId, agentId));

    return result.rowCount !== null && result.rowCount > 0;
  }

  /**
   * Replace all prompts for an agent
   * Removes existing prompts and assigns new ones
   */
  static async replacePrompts(
    input: AssignPromptsInput,
  ): Promise<AgentPrompt[]> {
    // Delete all existing prompts for this agent
    await AgentPromptModel.deleteAllByAgentId(input.agentId);

    const newAgentPrompts: AgentPrompt[] = [];

    // Add system prompt if provided (order 0)
    if (input.systemPromptId) {
      const systemPrompt = await AgentPromptModel.create({
        agentId: input.agentId,
        promptId: input.systemPromptId,
        order: 0,
      });
      newAgentPrompts.push(systemPrompt);
    }

    // Add regular prompts if provided (order 1, 2, 3, ...)
    if (input.regularPromptIds && input.regularPromptIds.length > 0) {
      for (let i = 0; i < input.regularPromptIds.length; i++) {
        const regularPrompt = await AgentPromptModel.create({
          agentId: input.agentId,
          promptId: input.regularPromptIds[i],
          order: i + 1,
        });
        newAgentPrompts.push(regularPrompt);
      }
    }

    return newAgentPrompts;
  }
}

export default AgentPromptModel;
