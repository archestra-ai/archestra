import { connectorSyncService } from "@/knowledge-base";
import logger from "@/logging";
import { KnowledgeBaseConnectorModel } from "@/models";

export async function handleConnectorPermissionSync(
  payload: Record<string, unknown>,
): Promise<void> {
  const connectorId = payload.connectorId as string;
  if (!connectorId) {
    throw new Error("Missing connectorId in connector_permission_sync payload");
  }

  const connector = await KnowledgeBaseConnectorModel.findById(connectorId);
  if (!connector) return;

  logger.info(
    { connectorId },
    "Starting background task handler for permission sync",
  );
  const result = await connectorSyncService.executePermissionSync(connectorId);
  logger.info(
    { connectorId, ...result },
    "Completed background task handler for permission sync",
  );
}
