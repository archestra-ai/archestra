/**
 * Entrypoint for running connector syncs as a standalone process.
 * Used by K8s CronJobs instead of the previous curl-based approach.
 *
 * Usage: node dist/entrypoints/connector-sync.mjs --connector-id=<uuid>
 */

import { connectorSyncService } from "@/services/connector-sync";
import { bootstrap, parseArg } from "./_shared/bootstrap";
import { createCapturingLogger } from "./_shared/log-capture";

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

    const result = await connectorSyncService.executeSync(connectorId, {
      logger,
      getLogOutput,
    });

    logger.info(
      { connectorId, runId: result.runId, status: result.status },
      "[ConnectorSync] Sync entrypoint finished",
    );

    process.exit(result.status === "success" ? 0 : 1);
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
