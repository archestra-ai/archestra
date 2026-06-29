import { and, eq } from "drizzle-orm";
import db, { schema } from "@/database";

class BrowserTabStateModel {
  static async get(
    agentId: string,
    userId: string,
    isolationKey: string,
  ): Promise<{
    url: string | null;
    tabIndex: number | null;
  } | null> {
    const result = await db
      .select({
        url: schema.browserTabStatesTable.url,
        tabIndex: schema.browserTabStatesTable.tabIndex,
      })
      .from(schema.browserTabStatesTable)
      .where(
        and(
          eq(schema.browserTabStatesTable.agentId, agentId),
          eq(schema.browserTabStatesTable.userId, userId),
          eq(schema.browserTabStatesTable.isolationKey, isolationKey),
        ),
      )
      .limit(1);

    return result[0] ?? null;
  }

  static async upsert(
    agentId: string,
    userId: string,
    isolationKey: string,
    state: { url?: string; tabIndex?: number },
  ): Promise<void> {
    await db
      .insert(schema.browserTabStatesTable)
      .values({
        agentId,
        userId,
        isolationKey,
        url: state.url ?? null,
        tabIndex: state.tabIndex ?? null,
      })
      .onConflictDoUpdate({
        target: [
          schema.browserTabStatesTable.agentId,
          schema.browserTabStatesTable.userId,
          schema.browserTabStatesTable.isolationKey,
        ],
        set: {
          url: state.url ?? null,
          tabIndex: state.tabIndex ?? null,
          updatedAt: new Date(),
        },
      });
  }

  static async delete(
    agentId: string,
    userId: string,
    isolationKey: string,
  ): Promise<void> {
    await db
      .delete(schema.browserTabStatesTable)
      .where(
        and(
          eq(schema.browserTabStatesTable.agentId, agentId),
          eq(schema.browserTabStatesTable.userId, userId),
          eq(schema.browserTabStatesTable.isolationKey, isolationKey),
        ),
      );
  }

  static async updateUrl(
    agentId: string,
    userId: string,
    isolationKey: string,
    url: string,
  ): Promise<void> {
    // Upsert: update if exists, insert if not
    await db
      .insert(schema.browserTabStatesTable)
      .values({
        agentId,
        userId,
        isolationKey,
        url,
      })
      .onConflictDoUpdate({
        target: [
          schema.browserTabStatesTable.agentId,
          schema.browserTabStatesTable.userId,
          schema.browserTabStatesTable.isolationKey,
        ],
        set: {
          url,
          updatedAt: new Date(),
        },
      });
  }

  static async getOldestForUser(userId: string): Promise<{
    agentId: string;
    isolationKey: string;
    url: string | null;
    tabIndex: number | null;
  } | null> {
    const result = await db
      .select({
        agentId: schema.browserTabStatesTable.agentId,
        isolationKey: schema.browserTabStatesTable.isolationKey,
        url: schema.browserTabStatesTable.url,
        tabIndex: schema.browserTabStatesTable.tabIndex,
      })
      .from(schema.browserTabStatesTable)
      .where(eq(schema.browserTabStatesTable.userId, userId))
      .orderBy(schema.browserTabStatesTable.updatedAt)
      .limit(1);

    return result[0] ?? null;
  }
}

export default BrowserTabStateModel;
