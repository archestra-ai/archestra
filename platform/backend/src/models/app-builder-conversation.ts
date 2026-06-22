import { and, eq, isNull } from "drizzle-orm";
import db, { schema, type Transaction } from "@/database";
import type { AppBuilderConversation } from "@/types/app-builder-conversation";
import { isUniqueConstraintError } from "@/utils/db";

/**
 * Binds App Builder conversations to the app they build (FR-25). A "New App"
 * opens a draft row (`appId` null); the conversation's first `create_app` claims
 * it via {@link bindDraft}. At most one builder conversation exists per
 * `(app, editor)` (LIM-19), enforced by a partial unique index; reopening an app
 * resumes that row's conversation, or establishes a fresh binding when the app
 * was created in an ordinary chat. Deleting the app severs the binding.
 */
class AppBuilderConversationModel {
  /** A builder conversation with no app yet — the state a "New App" opens in. */
  static async createDraft(
    params: {
      conversationId: string;
      editorUserId: string;
      organizationId: string;
    },
    tx?: Transaction,
  ): Promise<AppBuilderConversation> {
    const [row] = await (tx ?? db)
      .insert(schema.appBuilderConversationsTable)
      .values({ ...params, appId: null })
      .returning();
    return row;
  }

  /** A builder conversation already bound to an app — the resume-establish path. */
  static async createBound(
    params: {
      conversationId: string;
      appId: string;
      editorUserId: string;
      organizationId: string;
    },
    tx?: Transaction,
  ): Promise<AppBuilderConversation> {
    const [row] = await (tx ?? db)
      .insert(schema.appBuilderConversationsTable)
      .values(params)
      .returning();
    return row;
  }

  /**
   * First-write-wins: set `appId` on the editor's draft row for this
   * conversation. Returns the bound row, or null when there is no matching draft
   * — an ordinary chat (no row), an already-bound builder, or a different
   * editor. A concurrent bind that won the partial unique index is treated as
   * "already bound" (null), never an error.
   */
  static async bindDraft(
    params: { conversationId: string; appId: string; editorUserId: string },
    tx?: Transaction,
  ): Promise<AppBuilderConversation | null> {
    try {
      const [row] = await (tx ?? db)
        .update(schema.appBuilderConversationsTable)
        .set({ appId: params.appId })
        .where(
          and(
            eq(
              schema.appBuilderConversationsTable.conversationId,
              params.conversationId,
            ),
            eq(
              schema.appBuilderConversationsTable.editorUserId,
              params.editorUserId,
            ),
            isNull(schema.appBuilderConversationsTable.appId),
          ),
        )
        .returning();
      return row ?? null;
    } catch (error) {
      if (isUniqueConstraintError(error)) return null;
      throw error;
    }
  }

  /** The editor's builder conversation for an app, if one exists (resume lookup). */
  static async findByAppAndEditor(params: {
    appId: string;
    editorUserId: string;
  }): Promise<AppBuilderConversation | null> {
    const [row] = await db
      .select()
      .from(schema.appBuilderConversationsTable)
      .where(
        and(
          eq(schema.appBuilderConversationsTable.appId, params.appId),
          eq(
            schema.appBuilderConversationsTable.editorUserId,
            params.editorUserId,
          ),
        ),
      );
    return row ?? null;
  }

  /** The builder row for a conversation, if it is a builder (else null). */
  static async findByConversation(
    conversationId: string,
  ): Promise<AppBuilderConversation | null> {
    const [row] = await db
      .select()
      .from(schema.appBuilderConversationsTable)
      .where(
        eq(schema.appBuilderConversationsTable.conversationId, conversationId),
      );
    return row ?? null;
  }

  /** Sever every binding for an app (on delete); conversations are left intact. */
  static async severForApp(appId: string, tx?: Transaction): Promise<void> {
    await (tx ?? db)
      .delete(schema.appBuilderConversationsTable)
      .where(eq(schema.appBuilderConversationsTable.appId, appId));
  }
}

export default AppBuilderConversationModel;
