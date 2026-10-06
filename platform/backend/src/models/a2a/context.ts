import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { A2AContext, InsertA2AContext } from "@/types";
import { uuidv5 } from "@/utils/uuid";

class A2AContextModel {
  static async create(data: InsertA2AContext): Promise<A2AContext> {
    const [context] = await db
      .insert(schema.a2aContextsTable)
      .values(data)
      .returning();

    return context;
  }

  /**
   * One context row per organization, actor, agent, and external thread.
   *
   * The primary key is a UUIDv5 of those parts, so the row is the mapping.
   * A concurrent insert loses and reads the winner. A winner owned by a
   * different actor is refused — never adopted.
   */
  static async getOrCreateForExternalThread(params: {
    organizationId: string;
    actorKind: string;
    actorId: string;
    agentId: string;
    externalThread: string;
  }): Promise<A2AContext> {
    const id = continuationContextId(params);
    const [inserted] = await db
      .insert(schema.a2aContextsTable)
      .values({
        id,
        actorKind: params.actorKind,
        actorId: params.actorId,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) {
      return inserted;
    }

    const existing = await A2AContextModel.findById(id);
    if (
      !existing ||
      existing.actorKind !== params.actorKind ||
      existing.actorId !== params.actorId
    ) {
      throw new Error(
        "Refusing to reuse a continuation context owned by a different actor",
      );
    }
    return existing;
  }

  static async findById(id: string): Promise<A2AContext | null> {
    const [context] = await db
      .select()
      .from(schema.a2aContextsTable)
      .where(eq(schema.a2aContextsTable.id, id))
      .limit(1);

    return context ?? null;
  }

  static async delete(id: string): Promise<void> {
    await db
      .delete(schema.a2aContextsTable)
      .where(eq(schema.a2aContextsTable.id, id));
  }

  static async getTotalCount(): Promise<number> {
    const [{ count }] = await db
      .select({ count: sql<number>`count(${schema.a2aContextsTable.id})` })
      .from(schema.a2aContextsTable);

    return Number(count);
  }
}

export default A2AContextModel;

// Fixed namespace so the derived context id is stable across processes.
// Distinct from organization and engine ids.
const CONTINUATION_CONTEXT_NAMESPACE = "b7e1c4a2-9d30-4f68-a15c-2e8b6d0f4a91";

function continuationContextId(params: {
  organizationId: string;
  actorKind: string;
  actorId: string;
  agentId: string;
  externalThread: string;
}): string {
  if (
    !params.organizationId.trim() ||
    !params.actorKind.trim() ||
    !params.actorId.trim() ||
    !params.agentId.trim() ||
    !params.externalThread.trim()
  ) {
    throw new Error("Continuation context key is incomplete");
  }
  return uuidv5(
    JSON.stringify([
      "a2a-context:v1",
      params.organizationId,
      params.actorKind,
      params.actorId,
      params.agentId,
      params.externalThread,
    ]),
    CONTINUATION_CONTEXT_NAMESPACE,
  );
}
