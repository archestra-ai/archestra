import { and, asc, desc, eq, type SQL } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertInteraction, Interaction } from "@/types";

class InteractionModel {
  static async create(data: InsertInteraction) {
    const [interaction] = await db
      .insert(schema.interactionsTable)
      .values(data)
      .returning();

    return interaction;
  }

  static async findAll(): Promise<Interaction[]> {
    return db
      .select()
      .from(schema.interactionsTable)
      .orderBy(desc(schema.interactionsTable.createdAt));
  }

  static async findById(id: string): Promise<Interaction | null> {
    const [interaction] = await db
      .select()
      .from(schema.interactionsTable)
      .where(eq(schema.interactionsTable.id, id));

    return interaction || null;
  }

  static async getAllInteractionsForAgent(
    agentId: string,
    whereClauses?: SQL[],
  ) {
    return db
      .select()
      .from(schema.interactionsTable)
      .where(
        and(
          eq(schema.interactionsTable.agentId, agentId),
          ...(whereClauses ?? []),
        ),
      )
      .orderBy(asc(schema.interactionsTable.createdAt));
  }
}

export default InteractionModel;
