import { and, desc, eq, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import type { ConversationFileTouchKind } from "@/types/conversation-file-touch";

/**
 * The chat's file scope, used to confine which referenced files are returned so
 * the panel can never surface metadata outside what the chat can reach: a
 * project chat sees only that project's files; a personal chat only the owner's
 * personal files.
 */
type ConversationFileScope =
  | { kind: "project"; projectId: string }
  | { kind: "personal"; userId: string };

type ReferencedFileMeta = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: Date;
};

/**
 * Records which pre-existing files an agent read/edited in a conversation, so
 * the chat Files panel can show only the files the agent actually touched
 * instead of every file the user can reach. Files created in the conversation
 * are tracked by `files.conversation_id` and are not duplicated here.
 */
class ConversationFileTouchModel {
  /** Idempotent: the first touch of a (conversation, file) pair wins. */
  static async recordTouch(params: {
    organizationId: string;
    conversationId: string;
    fileId: string;
    touchKind: ConversationFileTouchKind;
  }): Promise<void> {
    await db
      .insert(schema.conversationFileTouchesTable)
      .values({
        organizationId: params.organizationId,
        conversationId: params.conversationId,
        fileId: params.fileId,
        touchKind: params.touchKind,
      })
      .onConflictDoNothing({
        target: [
          schema.conversationFileTouchesTable.conversationId,
          schema.conversationFileTouchesTable.fileId,
        ],
      });
  }

  /**
   * Files referenced in a conversation, joined to `files` so deleted files drop
   * out, newest touch first. Metadata only — bytes flow through the artifacts
   * route. The join is constrained to the same org and to the chat's file scope
   * (defense in depth: a referenced file can never be outside what the chat can
   * reach, regardless of what wrote the touch).
   */
  static async listReferencedFiles(params: {
    organizationId: string;
    conversationId: string;
    scope: ConversationFileScope;
  }): Promise<ReferencedFileMeta[]> {
    const scopePredicate =
      params.scope.kind === "project"
        ? eq(schema.filesTable.projectId, params.scope.projectId)
        : and(
            eq(schema.filesTable.userId, params.scope.userId),
            isNull(schema.filesTable.projectId),
          );
    return db
      .select({
        id: schema.filesTable.id,
        filename: schema.filesTable.filename,
        mimeType: schema.filesTable.mimeType,
        sizeBytes: schema.filesTable.sizeBytes,
        createdAt: schema.filesTable.createdAt,
      })
      .from(schema.conversationFileTouchesTable)
      .innerJoin(
        schema.filesTable,
        eq(schema.conversationFileTouchesTable.fileId, schema.filesTable.id),
      )
      .where(
        and(
          eq(
            schema.conversationFileTouchesTable.conversationId,
            params.conversationId,
          ),
          eq(
            schema.conversationFileTouchesTable.organizationId,
            params.organizationId,
          ),
          eq(schema.filesTable.organizationId, params.organizationId),
          scopePredicate,
        ),
      )
      .orderBy(desc(schema.conversationFileTouchesTable.createdAt));
  }
}

export default ConversationFileTouchModel;
