import { and, eq, isNotNull, lt } from "drizzle-orm";
import {
  decryptEncryptedChatValue,
  type EncryptedChatAuditContext,
  encryptEncryptedChatValue,
} from "@/content-encryption/encrypted-chat";
import db, { schema } from "@/database";
import { openPlainJson, sealPlainJson } from "@/openappa/plaintext-envelope";
import type { ThreadCall, ThreadTool } from "@/types/openappa-thread-state";
import { isContentEnvelope } from "@/utils/crypto";

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
    encryptedChat?: EncryptedChatAuditContext;
  }): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .insert(table)
        .values({
          organizationId: params.organizationId,
          messageId: params.messageId,
          sessionId: params.sessionId,
          rootMessageId: params.rootMessageId,
          tools:
            params.encryptedChat && params.tools
              ? (encryptEncryptedChatValue(params.tools, {
                  ...params.encryptedChat,
                  context: "openappa_thread_states.tools",
                }) as ThreadTool[])
              : params.tools
                ? (sealPlainJson(params.tools) as ThreadTool[])
                : null,
          calls: params.encryptedChat
            ? (encryptEncryptedChatValue(params.calls, {
                ...params.encryptedChat,
                context: "openappa_thread_states.calls",
              }) as ThreadCall[])
            : // A tool input holding a NUL cannot be stored in jsonb as it is.
              (sealPlainJson(params.calls) as ThreadCall[]),
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
    encryptedChat?: EncryptedChatAuditContext;
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
    if (
      !params.encryptedChat &&
      (isContentEnvelope(tools) || isContentEnvelope(row.calls))
    ) {
      throw new Error("Encrypted thread state requires its conversation key");
    }
    if (!params.encryptedChat) {
      tools = openPlainJson(tools) as ThreadTool[] | null;
      row.calls = openPlainJson(row.calls) as ThreadCall[] | null;
    } else {
      tools =
        tools === null
          ? null
          : (decryptEncryptedChatValue(tools, {
              ...params.encryptedChat,
              context: "openappa_thread_states.tools",
            }) as ThreadTool[]);
      row.calls =
        row.calls === null
          ? null
          : (decryptEncryptedChatValue(row.calls, {
              ...params.encryptedChat,
              context: "openappa_thread_states.calls",
            }) as ThreadCall[]);
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
