import { and, desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  A2aOutboundRun,
  InsertA2aOutboundRun,
} from "@/types/a2a-outbound";

class A2aOutboundRunModel {
  static async findRecentForRemoteAgent(params: {
    organizationId: string;
    remoteAgentId: string;
    limit: number;
  }): Promise<A2aOutboundRun[]> {
    return db
      .select()
      .from(schema.a2aOutboundRunsTable)
      .where(
        and(
          eq(schema.a2aOutboundRunsTable.organizationId, params.organizationId),
          eq(schema.a2aOutboundRunsTable.remoteAgentId, params.remoteAgentId),
        ),
      )
      .orderBy(desc(schema.a2aOutboundRunsTable.startedAt))
      .limit(params.limit);
  }

  static async create(data: InsertA2aOutboundRun): Promise<A2aOutboundRun> {
    const [run] = await db
      .insert(schema.a2aOutboundRunsTable)
      .values(data)
      .returning();
    return run;
  }

  static async update(
    id: string,
    data: Partial<InsertA2aOutboundRun>,
  ): Promise<A2aOutboundRun | null> {
    const [run] = await db
      .update(schema.a2aOutboundRunsTable)
      .set(data)
      .where(eq(schema.a2aOutboundRunsTable.id, id))
      .returning();
    return run ?? null;
  }
}

export default A2aOutboundRunModel;
