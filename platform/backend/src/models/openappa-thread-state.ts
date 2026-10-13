import { and, eq, isNotNull, lt } from "drizzle-orm";
import db, { schema } from "@/database";
import type { ThreadCall, ThreadTool } from "@/types/openappa-thread-state";

const table = schema.openappaThreadStatesTable;

/**
 * What the proxy ruled on for a provider-side thread, one row per governed
 * response. A row is written once (a second write of it does nothing) and only
 * its `calls` are ever cleared, when the next response of the thread is kept.
 */
class OpenAppaThreadStateModel {
  /**
   * Keeps a response's row. A thread message continues once, so the row this
   * one follows will never be ruled on again: its calls go in the same write.
   */
  static async record(params: {
    organizationId: string;
    messageId: string;
    sessionId: string;
    rootMessageId: string;
    tools?: ThreadTool[];
    calls: ThreadCall[];
    diverged: boolean;
    previousMessageId?: string;
  }): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .insert(table)
        .values({
          organizationId: params.organizationId,
          messageId: params.messageId,
          sessionId: params.sessionId,
          rootMessageId: params.rootMessageId,
          tools: params.tools ?? null,
          calls: params.calls,
          diverged: params.diverged,
        })
        .onConflictDoNothing();
      if (params.previousMessageId)
        await tx
          .update(table)
          .set({ calls: null })
          .where(
            and(
              eq(table.organizationId, params.organizationId),
              eq(table.messageId, params.previousMessageId),
              isNotNull(table.calls),
            ),
          );
    });
  }

  /** The row for `messageId` with the tools of the root it follows. */
  static async find(params: {
    organizationId: string;
    messageId: string;
  }): Promise<{
    sessionId: string;
    rootMessageId: string;
    diverged: boolean;
    tools: ThreadTool[] | null;
    /** Null once the response has been continued. */
    calls: ThreadCall[] | null;
  } | null> {
    const [row] = await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.organizationId, params.organizationId),
          eq(table.messageId, params.messageId),
        ),
      );
    if (!row) return null;
    let tools = row.tools;
    if (!tools && row.rootMessageId !== row.messageId) {
      const [root] = await db
        .select({ tools: table.tools })
        .from(table)
        .where(
          and(
            eq(table.organizationId, params.organizationId),
            eq(table.messageId, row.rootMessageId),
          ),
        );
      tools = root?.tools ?? null;
    }
    return {
      sessionId: row.sessionId,
      rootMessageId: row.rootMessageId,
      diverged: row.diverged,
      tools,
      calls: row.calls,
    };
  }

  /** Deletes the rows written before `before`; returns how many went. */
  static async deleteOlderThan(before: Date): Promise<number> {
    const result = await db.delete(table).where(lt(table.createdAt, before));
    return result.rowCount ?? 0;
  }
}

export default OpenAppaThreadStateModel;
