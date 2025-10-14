import { and, asc, count, desc, eq, type SQL } from "drizzle-orm";
import db, { schema } from "@/database";
import {
  createPaginatedResult,
  type PaginatedResult,
} from "@/database/utils/pagination";
import type { InsertInteraction, Interaction, PaginationQuery } from "@/types";

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

  /**
   * Find all interactions with pagination support
   */
  static async findAllPaginated(
    pagination: PaginationQuery,
  ): Promise<PaginatedResult<Interaction>> {
    const [data, [{ total }]] = await Promise.all([
      db
        .select()
        .from(schema.interactionsTable)
        .orderBy(desc(schema.interactionsTable.createdAt))
        .limit(pagination.limit)
        .offset(pagination.offset),
      db.select({ total: count() }).from(schema.interactionsTable),
    ]);

    return createPaginatedResult(data, Number(total), pagination);
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

  /**
   * Get all interactions for an agent with pagination support
   */
  static async getAllInteractionsForAgentPaginated(
    agentId: string,
    pagination: PaginationQuery,
    whereClauses?: SQL[],
  ): Promise<PaginatedResult<Interaction>> {
    const whereCondition = and(
      eq(schema.interactionsTable.agentId, agentId),
      ...(whereClauses ?? []),
    );

    const [data, [{ total }]] = await Promise.all([
      db
        .select()
        .from(schema.interactionsTable)
        .where(whereCondition)
        .orderBy(asc(schema.interactionsTable.createdAt))
        .limit(pagination.limit)
        .offset(pagination.offset),
      db
        .select({ total: count() })
        .from(schema.interactionsTable)
        .where(whereCondition),
    ]);

    return createPaginatedResult(data, Number(total), pagination);
  }
}

export default InteractionModel;
