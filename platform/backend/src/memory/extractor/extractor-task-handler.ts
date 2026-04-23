import { z } from "zod";
import config from "@/config";
import logger from "@/logging";
import { reportMemoryPolicyBlocked } from "@/memory/telemetry/metrics";
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
      "[memory] extract: skipped (feature flag disabled)",
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
      "[memory] extract: skipped (pending duplicate task)",
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
      "[memory] extract: skipped (conversation not found)",
    );
    return;
  }

  if (hasExternalContextBoundary(conversation.messages as ChatMessage[])) {
    reportMemoryPolicyBlocked("external_context");
    logger.info(
      {
        conversationId: parsedPayload.conversationId,
      },
      "[memory] extract: skipped (external context boundary)",
    );
    return;
  }

  const archivedCount = await MemoryItemModel.archiveStaleCandidates({
    ttlDays: config.memory.candidateTtlDays,
  });
  if (archivedCount > 0) {
    logger.info(
      { archivedCount, conversationId: parsedPayload.conversationId },
      "[memory] extract: archived stale candidates before run",
    );
  }

  try {
    const result = await memoryExtractor.extract(parsedPayload);
    logger.info(
      {
        conversationId: parsedPayload.conversationId,
        result,
      },
      "[memory] extract: finished",
    );
  } catch (error) {
    logger.error(
      {
        conversationId: parsedPayload.conversationId,
        error: error instanceof Error ? error.message : String(error),
      },
      "[memory] extract: failed",
    );
    throw error;
  }
}
