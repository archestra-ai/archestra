import { createCapturingLogger } from "@/entrypoints/_shared/log-capture";
import { connectorPruneService } from "@/knowledge-base";

export async function handleConnectorPrune(
  payload: Record<string, unknown>,
): Promise<void> {
  const connectorId = payload.connectorId as string;

  if (!connectorId) {
    throw new Error("Missing connectorId in connector_prune payload");
  }

  const { logger, getLogOutput } = createCapturingLogger();

  await connectorPruneService.executePrune(connectorId, {
    logger,
    getLogOutput,
  });
}