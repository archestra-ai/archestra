// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import config from "@/config";
import { withDbTransaction } from "@/database";
import logger from "@/logging";
import {
  ConversationModel,
  InteractionModel,
  McpToolCallModel,
} from "@/models";
import { fileStore } from "@/skills-sandbox/file-store";

/**
 * Enterprise data-retention sweep over the three content-bearing tables.
 * Each table is swept independently — one failure never blocks the others,
 * matching the audit-log sweep's swallow-and-log posture so the periodic
 * chain always reschedules. A fast no-op while every window is disabled.
 * Licensing is asserted at boot (data-retention/license-gate.ee.ts), so an
 * unlicensed deployment with retention configured never reaches this handler.
 */
export async function handleContentRetentionCleanup(): Promise<void> {
  const { llmLogsDays, mcpLogsDays, chatConversationsDays } = config.retention;

  if (llmLogsDays === 0 && mcpLogsDays === 0 && chatConversationsDays === 0) {
    return;
  }

  if (llmLogsDays > 0) {
    try {
      const deleted = await InteractionModel.deleteExpired({
        retentionDays: llmLogsDays,
      });
      logger.info(
        { deleted, retentionDays: llmLogsDays },
        "interaction retention sweep: complete",
      );
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "interaction retention sweep: failed",
      );
    }
  }

  if (mcpLogsDays > 0) {
    try {
      const deleted = await McpToolCallModel.deleteExpired({
        retentionDays: mcpLogsDays,
      });
      logger.info(
        { deleted, retentionDays: mcpLogsDays },
        "mcp tool-call retention sweep: complete",
      );
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "mcp tool-call retention sweep: failed",
      );
    }
  }

  if (chatConversationsDays > 0) {
    try {
      const deleted = await sweepExpiredConversations(chatConversationsDays);
      logger.info(
        { deleted, retentionDays: chatConversationsDays },
        "conversation retention sweep: complete",
      );
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "conversation retention sweep: failed",
      );
    }
  }
}

// === Internal ===

const CONVERSATION_BATCH_SIZE = 50;
const CONVERSATION_MAX_BATCHES = 200;

async function sweepExpiredConversations(
  retentionDays: number,
): Promise<number> {
  let totalDeleted = 0;

  for (let batch = 0; batch < CONVERSATION_MAX_BATCHES; batch++) {
    const candidates = await ConversationModel.findExpired({
      retentionDays,
      limit: CONVERSATION_BATCH_SIZE,
    });
    if (candidates.length === 0) break;

    for (const candidate of candidates) {
      try {
        if (await deleteExpiredConversation(candidate, retentionDays)) {
          totalDeleted++;
        }
      } catch (error) {
        // One stuck conversation must not stop the sweep; it is retried on
        // the next run.
        logger.warn(
          {
            conversationId: candidate.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "conversation retention sweep: candidate failed, skipping",
        );
      }
    }

    if (candidates.length < CONVERSATION_BATCH_SIZE) break;
  }

  return totalDeleted;
}

/**
 * Delete one expired conversation race-safely: lock the row, re-check expiry
 * under the lock (a message that landed since selection revives it), purge its
 * no-project file ROWS in the same transaction (prevents the orphaned-files
 * partial-unique-index collision aborting the cascade), delete, commit — then
 * best-effort delete the external file bytes, mirroring the manual delete
 * route's guarantees.
 */
async function deleteExpiredConversation(
  candidate: { id: string; organizationId: string },
  retentionDays: number,
): Promise<boolean> {
  let purgeBytes: (() => Promise<void>) | null = null;

  const deleted = await withDbTransaction(async (tx) => {
    const locked = await ConversationModel.lockIfExpired(tx, {
      id: candidate.id,
      retentionDays,
    });
    if (!locked) return false;

    purgeBytes = await fileStore.purgeConversationFileRows(
      {
        organizationId: locked.organizationId,
        conversationId: locked.id,
      },
      tx,
    );
    await ConversationModel.deleteExpiredLocked(tx, locked.id);
    return true;
  });

  if (deleted && purgeBytes) {
    await (purgeBytes as () => Promise<void>)();
  }
  return deleted;
}
