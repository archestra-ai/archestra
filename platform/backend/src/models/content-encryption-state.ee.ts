// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";

type ContentEncryptionState =
  typeof schema.contentEncryptionStateTable.$inferSelect;

const SINGLETON_ID = "content";

/**
 * Progress bookkeeping for the content-encryption backfill sweep — a single
 * row advanced with plain single-row UPDATEs. Batches themselves are
 * idempotent (encrypt-if-plaintext / re-encrypt-if-previous-key with
 * compare-and-swap row rewrites), so no cross-runner locking is needed: a
 * concurrent runner is merely redundant.
 */
class ContentEncryptionStateModel {
  /**
   * The state row for the given CURRENT-key fingerprint, creating or —
   * after a rotation (fingerprint changed) — resetting it so the sweep
   * restarts from the beginning.
   */
  static async ensureForFingerprint(
    keyFingerprint: string,
  ): Promise<ContentEncryptionState> {
    const [existing] = await db
      .select()
      .from(schema.contentEncryptionStateTable)
      .where(eq(schema.contentEncryptionStateTable.id, SINGLETON_ID));

    if (existing && existing.keyFingerprint === keyFingerprint) {
      return existing;
    }

    if (!existing) {
      const [inserted] = await db
        .insert(schema.contentEncryptionStateTable)
        .values({ id: SINGLETON_ID, keyFingerprint })
        .onConflictDoNothing({
          target: schema.contentEncryptionStateTable.id,
        })
        .returning();
      if (inserted) return inserted;
      // A concurrent runner inserted first — recurse once to resolve against
      // its row (and reset it if its fingerprint is stale).
      return ContentEncryptionStateModel.ensureForFingerprint(keyFingerprint);
    }

    const [reset] = await db
      .update(schema.contentEncryptionStateTable)
      .set({
        keyFingerprint,
        interactionsCursorCreatedAt: null,
        interactionsCursorId: null,
        messagesCursorId: null,
        mcpToolCallsCursorId: null,
        completedAt: null,
      })
      .where(eq(schema.contentEncryptionStateTable.id, SINGLETON_ID))
      .returning();
    return reset;
  }

  static async advanceInteractionsCursor(cursor: {
    createdAt: string;
    id: string;
  }): Promise<void> {
    await db
      .update(schema.contentEncryptionStateTable)
      .set({
        interactionsCursorCreatedAt: cursor.createdAt,
        interactionsCursorId: cursor.id,
      })
      .where(eq(schema.contentEncryptionStateTable.id, SINGLETON_ID));
  }

  static async advanceMessagesCursor(messageId: string): Promise<void> {
    await db
      .update(schema.contentEncryptionStateTable)
      .set({ messagesCursorId: messageId })
      .where(eq(schema.contentEncryptionStateTable.id, SINGLETON_ID));
  }

  static async advanceMcpToolCallsCursor(toolCallId: string): Promise<void> {
    await db
      .update(schema.contentEncryptionStateTable)
      .set({ mcpToolCallsCursorId: toolCallId })
      .where(eq(schema.contentEncryptionStateTable.id, SINGLETON_ID));
  }

  static async markCompleted(): Promise<void> {
    await db
      .update(schema.contentEncryptionStateTable)
      .set({ completedAt: new Date() })
      .where(eq(schema.contentEncryptionStateTable.id, SINGLETON_ID));
  }

  /**
   * Restart the sweep from the beginning for the SAME key: clear the cursors
   * and completion mark. Used by the operator script's full re-verify — rows
   * written in plaintext by not-yet-restarted replicas during the enablement
   * rollout can land behind a completed sweep, and only a from-scratch pass
   * picks them up (already-encrypted rows are cheap CAS-skip reads).
   */
  static async restart(): Promise<void> {
    await db
      .update(schema.contentEncryptionStateTable)
      .set({
        interactionsCursorCreatedAt: null,
        interactionsCursorId: null,
        messagesCursorId: null,
        mcpToolCallsCursorId: null,
        completedAt: null,
      })
      .where(eq(schema.contentEncryptionStateTable.id, SINGLETON_ID));
  }
}

export default ContentEncryptionStateModel;
