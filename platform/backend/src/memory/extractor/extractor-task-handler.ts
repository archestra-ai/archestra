import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { ConversationModel, MemoryItemModel, TaskModel } from "@/models";
import type { ChatMessage } from "@/types";
import { hasExternalContextBoundary, memoryExtractor } from "./extractor";

const ExtractMemoryPayloadSchema = z.object({
  conversationId: z.string().uuid(),
  userId: z.string().min(1),
  organizationId: z.string().min(1),
  agentId: z.string().uuid(),
});

export async function handleExtractMemoryCandidates(
  payload: Record<string, unknown>,
): Promise<void> {
  const parsedPayload = ExtractMemoryPayloadSchema.parse(payload);

  if (!config.memory.extractionEnabled) {
    logger.info(
      {
        conversationId: parsedPayload.conversationId,
        organizationId: parsedPayload.organizationId,
      },
      "[MemoryExtractorTask] Extraction disabled by feature flag, skipping",
    );
    return;
  }

  const hasPendingDuplicate = await TaskModel.hasPendingByTypeAndPayload({
    taskType: "memory_extract_candidates",
    conversationId: parsedPayload.conversationId,
  });
  if (hasPendingDuplicate) {
    logger.info(
      {
        conversationId: parsedPayload.conversationId,
      },
      "[MemoryExtractorTask] Pending duplicate task exists, skipping",
    );
    return;
  }

  const conversation = await ConversationModel.findById({
    id: parsedPayload.conversationId,
    userId: parsedPayload.userId,
    organizationId: parsedPayload.organizationId,
  });
  if (!conversation) {
    logger.info(
      {
        conversationId: parsedPayload.conversationId,
      },
      "[MemoryExtractorTask] Conversation not found, skipping",
    );
    return;
  }

  if (hasExternalContextBoundary(conversation.messages as ChatMessage[])) {
    logger.info(
      {
        conversationId: parsedPayload.conversationId,
      },
      "[MemoryExtractorTask] External-context conversation, skipping extraction",
    );
    return;
  }

  const archivedCount = await MemoryItemModel.archiveStaleCandidates({
    ttlDays: config.memory.candidateTtlDays,
  });
  if (archivedCount > 0) {
    logger.info(
      { archivedCount, conversationId: parsedPayload.conversationId },
      "[MemoryExtractorTask] Archived stale candidates before extraction",
    );
  }

  try {
    const result = await memoryExtractor.extract(parsedPayload);
    logger.info(
      {
        conversationId: parsedPayload.conversationId,
        result,
      },
      "[MemoryExtractorTask] Extraction finished",
    );
  } catch (error) {
    logger.error(
      {
        conversationId: parsedPayload.conversationId,
        error: error instanceof Error ? error.message : String(error),
      },
      "[MemoryExtractorTask] Extraction failed",
    );
    throw error;
  }
}
