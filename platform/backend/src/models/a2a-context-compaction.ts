import { desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  A2AContextCompaction,
  InsertA2AContextCompaction,
} from "@/types/a2a-context-compaction";

class A2AContextCompactionModel {
  static async create(
    data: InsertA2AContextCompaction,
  ): Promise<A2AContextCompaction> {
    const [record] = await db
      .insert(schema.a2aContextCompactionsTable)
      .values(data)
      .returning();

    return record;
  }

  static async findLatestByContext(
    contextId: string,
  ): Promise<A2AContextCompaction | null> {
    const [record] = await db
      .select()
      .from(schema.a2aContextCompactionsTable)
      .where(eq(schema.a2aContextCompactionsTable.contextId, contextId))
      .orderBy(desc(schema.a2aContextCompactionsTable.createdAt))
      .limit(1);

    return record ?? null;
  }
}

export default A2AContextCompactionModel;
