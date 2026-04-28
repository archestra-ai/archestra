import logger from "@/logging";
import {
  reportMemoryMaintenanceDuration,
  reportMemoryMaintenanceRetried,
} from "@/memory/telemetry/metrics";
import {
  ConversationModel,
  MemoryItemModel,
  MemoryTombstoneModel,
  OrganizationModel,
} from "@/models";
import { taskQueueService } from "@/task-queue";

const MAX_RETRIES_PER_ORG = 50;

export async function handleMemoryMaintenance(): Promise<void> {
  const startedAtMs = Date.now();

  try {
    const organizations = await OrganizationModel.listAll();

    for (const organization of organizations) {
      try {
        const archivedCandidatesCount =
          await MemoryItemModel.archiveStaleCandidates({
            organizationId: organization.id,
            ttlDays: organization.memoryCandidateTtlDays,
          });

        const deletedTombstonesCount = await MemoryTombstoneModel.deleteExpired(
          {
            organizationId: organization.id,
            ttlDays: organization.memoryTombstoneTtlDays,
          },
        );

        let retriedCount = 0;
        if (organization.memoryExtractionEnabled) {
          const failedConversations =
            await ConversationModel.listFailedMemoryExtractionByOrg({
              organizationId: organization.id,
              limit: MAX_RETRIES_PER_ORG,
            });

          for (const conversation of failedConversations) {
            await taskQueueService.enqueue({
              taskType: "memory_extract_candidates",
              payload: {
                conversationId: conversation.id,
                userId: conversation.userId,
                organizationId: conversation.organizationId,
                agentId: conversation.agentId,
              },
            });

            await ConversationModel.setMemoryExtractionStatus({
              id: conversation.id,
              status: "pending",
            });
            retriedCount += 1;
          }
        }

        reportMemoryMaintenanceRetried({
          organizationId: organization.id,
          total: retriedCount,
        });

        logger.info(
          {
            organizationId: organization.id,
            archivedCandidatesCount,
            deletedTombstonesCount,
            retriedCount,
          },
          "[memory] maintenance: organization pass completed",
        );
      } catch (error) {
        logger.error(
          {
            organizationId: organization.id,
            error: error instanceof Error ? error.message : String(error),
          },
          "[memory] maintenance: organization pass failed",
        );
      }
    }
  } finally {
    reportMemoryMaintenanceDuration({
      durationSeconds: (Date.now() - startedAtMs) / 1000,
    });
  }
}
