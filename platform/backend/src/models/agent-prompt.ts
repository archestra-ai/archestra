import { and, asc, eq, getTableColumns } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  AgentPrompt,
  AssignAgentPrompts,
  InsertAgentPrompt,
} from "@/types";

/**
 * Model for managing agent-prompt relationships
 * Handles assigning prompts to agents
 */
class AgentPromptModel {
  /**
   * Assign a single prompt to an agent
   */
  static async create(input: InsertAgentPrompt): Promise<AgentPrompt> {
    const [agentPrompt] = await db
      .insert(schema.agentPromptsTable)
      .values({
        agentId: input.agentId,
        promptId: input.promptId,
        order: input.order || 0,
      })
      .returning();

    return agentPrompt;
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

    return agentPrompts;
  }

  /**
   * Get all prompts assigned to an agent with full prompt details
   */
  static async findByAgentIdWithPrompts(agentId: string) {
    const agentPrompts = await db
      .select({
        ...getTableColumns(schema.agentPromptsTable),
        prompt: getTableColumns(schema.promptsTable),
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
    agentId: string,
    input: AssignAgentPrompts,
  ): Promise<AgentPrompt[]> {
    // Delete all existing prompts for this agent
    await AgentPromptModel.deleteAllByAgentId(agentId);

    const newAgentPrompts: AgentPrompt[] = [];

    // Add system prompt if provided (order 0)
    if (input.systemPromptId) {
      const systemPrompt = await AgentPromptModel.create({
        agentId,
        promptId: input.systemPromptId,
        order: 0,
      });
      newAgentPrompts.push(systemPrompt);
    }

    // Add regular prompts if provided (order 1, 2, 3, ...)
    if (input.regularPromptIds && input.regularPromptIds.length > 0) {
      for (let i = 0; i < input.regularPromptIds.length; i++) {
        const regularPrompt = await AgentPromptModel.create({
          agentId,
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
