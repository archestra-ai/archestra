import { z } from "zod";
import logger from "@/logging";
import {
  reportMemoryExtractionStatus,
  reportMemoryPolicyBlocked,
  reportMemoryScreenDecision,
} from "@/memory/telemetry/metrics";
import { ConversationModel, OrganizationModel, TaskModel } from "@/models";
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

  const organization = await OrganizationModel.getById(
    parsedPayload.organizationId,
  );
  if (!organization?.memoryExtractionEnabled) {
    await setExtractionStatus({
      conversationId: parsedPayload.conversationId,
      organizationId: parsedPayload.organizationId,
      status: "skipped",
    });
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

  await setExtractionStatus({
    conversationId: parsedPayload.conversationId,
    organizationId: parsedPayload.organizationId,
    status: "pending",
    attemptedAt: new Date(),
  });

  if (hasExternalContextBoundary(conversation.messages as ChatMessage[])) {
    reportMemoryPolicyBlocked("external_context");
    reportMemoryScreenDecision({
      decision: "block",
      reason: "external_context_marker",
    });
    logger.info(
      {
        conversationId: parsedPayload.conversationId,
      },
      "[memory] extract: skipped (external context boundary)",
    );
    await setExtractionStatus({
      conversationId: parsedPayload.conversationId,
      organizationId: parsedPayload.organizationId,
      status: "skipped",
    });
    return;
  }

  try {
    const result = await memoryExtractor.extract(parsedPayload);
    if (result.status === "completed") {
      await setExtractionStatus({
        conversationId: parsedPayload.conversationId,
        organizationId: parsedPayload.organizationId,
        status: "completed",
        extractedAt: new Date(),
      });
    } else {
      await setExtractionStatus({
        conversationId: parsedPayload.conversationId,
        organizationId: parsedPayload.organizationId,
        status: "skipped",
      });
    }
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
    await setExtractionStatus({
      conversationId: parsedPayload.conversationId,
      organizationId: parsedPayload.organizationId,
      status: "failed",
    });
    throw error;
  }
}

async function setExtractionStatus(params: {
  conversationId: string;
  organizationId: string;
  status: "pending" | "completed" | "failed" | "skipped";
  attemptedAt?: Date;
  extractedAt?: Date;
}): Promise<void> {
  await ConversationModel.setMemoryExtractionStatus({
    id: params.conversationId,
    status: params.status,
    attemptedAt: params.attemptedAt,
    extractedAt: params.extractedAt,
  });
  reportMemoryExtractionStatus({
    status: params.status,
    organizationId: params.organizationId,
  });
}
