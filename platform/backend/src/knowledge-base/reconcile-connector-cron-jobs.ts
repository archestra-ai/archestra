import { cronJobManager } from "@/k8s/cron-job";
import logger from "@/logging";
import KnowledgeBaseConnectorModel from "@/models/knowledge-base-connector";

/**
 * Reconcile CronJobs for enabled connectors.
 * Ensures that every enabled connector has a corresponding K8s CronJob.
 * Runs on server startup to handle cases where CronJobs were deleted externally.
 */
export async function reconcileConnectorCronJobs(): Promise<void> {
  try {
    cronJobManager.initialize();
  } catch {
    logger.info(
      "[CronJobReconcile] CronJobManager not available, skipping reconciliation",
    );
    return;
  }

  const connectors = await KnowledgeBaseConnectorModel.findAllEnabled();
  if (connectors.length === 0) {
    return;
  }

  let reconciled = 0;
  for (const connector of connectors) {
    try {
      await cronJobManager.createOrUpdateCronJob({
        connectorId: connector.id,
        schedule: connector.schedule,
      });
      reconciled++;
    } catch (error) {
      logger.warn(
        {
          connectorId: connector.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "[CronJobReconcile] Failed to reconcile CronJob",
      );
    }
  }

  if (reconciled > 0) {
    logger.info(
      { reconciled, total: connectors.length },
      "[CronJobReconcile] Connector CronJobs reconciled",
    );
  }
}
