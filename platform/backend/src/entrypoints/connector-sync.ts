/**
 * Entrypoint for running connector syncs as a standalone process.
 * Used by K8s CronJobs
 *
 * Usage: node dist/entrypoints/connector-sync.mjs --connector-id=<uuid>
 */

import { cronJobManager } from "@/k8s/cron-job";
import { connectorSyncService } from "@/knowledge-base/connector-sync";
import { bootstrap, parseArg } from "./_shared/bootstrap";
import { createCapturingLogger } from "./_shared/log-capture";

const DEFAULT_MAX_DURATION_SECONDS = 3300; // 55 minutes
const MAX_CONTINUATIONS = 50;

async function main(): Promise<void> {
  const connectorId = parseArg("connector-id");
  if (!connectorId) {
    console.error("Usage: connector-sync --connector-id=<uuid>");
    process.exit(1);
  }

  const { logger, getLogOutput } = createCapturingLogger();

  logger.info({ connectorId }, "[ConnectorSync] Starting sync entrypoint");

  try {
    await bootstrap();

    const maxDurationSeconds = Number.parseInt(
      process.env.ARCHESTRA_CONNECTOR_SYNC_MAX_DURATION_SECONDS ||
        String(DEFAULT_MAX_DURATION_SECONDS),
      10,
    );
    const maxDurationMs =
      !Number.isNaN(maxDurationSeconds) && maxDurationSeconds > 0
        ? maxDurationSeconds * 1000
        : undefined;

    const continuationCount = Number.parseInt(
      process.env.ARCHESTRA_CONNECTOR_CONTINUATION_COUNT || "0",
      10,
    );

    const result = await connectorSyncService.executeSync(connectorId, {
      logger,
      getLogOutput,
      maxDurationMs,
    });

    logger.info(
      { connectorId, runId: result.runId, status: result.status },
      "[ConnectorSync] Sync entrypoint finished",
    );

    // On partial result, trigger a continuation job
    if (result.status === "partial") {
      if (continuationCount < MAX_CONTINUATIONS) {
        logger.info(
          { connectorId, continuationCount: continuationCount + 1 },
          "[ConnectorSync] Triggering continuation job",
        );
        await cronJobManager.triggerContinuationJob({
          connectorId,
          continuationCount: continuationCount + 1,
        });
      } else {
        logger.warn(
          { connectorId, maxContinuations: MAX_CONTINUATIONS },
          "[ConnectorSync] Max continuations reached, not continuing",
        );
      }
    }

    process.exit(
      result.status === "success" || result.status === "partial" ? 0 : 1,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.fatal(
      { connectorId, error: message },
      "[ConnectorSync] Fatal error",
    );
    process.exit(1);
  }
}

main();
