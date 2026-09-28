import { and, asc, eq, inArray } from "drizzle-orm";
import db, { schema, type Transaction, withDbTransaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import type { SuggestedPromptInput } from "@/types";

class AgentSuggestedPromptModel {
  /**
   * Replace all suggested prompts for an agent with the given list.
   * Preserves ordering via sortOrder based on array index.
   */
  static async syncForAgent(params: {
    agentId: string;
    prompts: SuggestedPromptInput[];
    tx?: Transaction;
  }): Promise<void> {
    const { agentId, prompts } = params;
    const sync = async (tx: Transaction) => {
      await tx
        .delete(schema.agentSuggestedPromptsTable)
        .where(eq(schema.agentSuggestedPromptsTable.agentId, agentId));

      if (prompts.length === 0) return;

      await tx.insert(schema.agentSuggestedPromptsTable).values(
        prompts.map((p, index) => ({
          agentId,
          summaryTitle: p.summaryTitle,
          prompt: p.prompt,
          sortOrder: index,
        })),
      );
    };
    if (params.tx) await sync(params.tx);
    else await withDbTransaction(sync);
  }

  /**
   * Get all suggested prompts for an agent, ordered by sortOrder.
   */
  static async getForAgent(
    agentId: string,
    tx?: Transaction,
  ): Promise<SuggestedPromptInput[]> {
    const rows = await (tx ?? db)
      .select({
        summaryTitle: schema.agentSuggestedPromptsTable.summaryTitle,
        prompt: schema.agentSuggestedPromptsTable.prompt,
      })
      .from(schema.agentSuggestedPromptsTable)
      .innerJoin(
        schema.agentsTable,
        eq(schema.agentSuggestedPromptsTable.agentId, schema.agentsTable.id),
      )
      .where(
        and(
          eq(schema.agentSuggestedPromptsTable.agentId, agentId),
          notDeleted(schema.agentsTable),
        ),
      )
      .orderBy(asc(schema.agentSuggestedPromptsTable.sortOrder));

    return rows;
  }

  /**
   * Batch-get suggested prompts for multiple agents.
   * Returns a Map from agentId → SuggestedPromptInput[].
   */
  static async getForAgents(
    agentIds: string[],
  ): Promise<Map<string, SuggestedPromptInput[]>> {
    if (agentIds.length === 0) return new Map();

    const rows = await db
      .select({
        agentId: schema.agentSuggestedPromptsTable.agentId,
        summaryTitle: schema.agentSuggestedPromptsTable.summaryTitle,
        prompt: schema.agentSuggestedPromptsTable.prompt,
      })
      .from(schema.agentSuggestedPromptsTable)
      .where(inArray(schema.agentSuggestedPromptsTable.agentId, agentIds))
      .orderBy(asc(schema.agentSuggestedPromptsTable.sortOrder));

    const map = new Map<string, SuggestedPromptInput[]>();
    for (const row of rows) {
      const existing = map.get(row.agentId) ?? [];
      existing.push({ summaryTitle: row.summaryTitle, prompt: row.prompt });
      map.set(row.agentId, existing);
    }
    return map;
  }
}

export default AgentSuggestedPromptModel;
