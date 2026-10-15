import logger from "@/logging";
import { McpServerModel } from "@/models";
import {
  autoReinstallServer,
  reinstallMultitenantCatalog,
} from "@/services/mcp-reinstall";
import type { InternalMcpCatalog } from "@/types";
import { broadcastMcpInstallationStatus } from "@/websocket";

/**
 * Roll a local catalog's installs onto the image its reference points at now,
 * pulling it afresh. A multi-tenant catalog recreates its one shared pod; a
 * single-tenant catalog restarts each install — every one, or only `serverIds`
 * when given (the background image-update check restarts just the installs
 * it found running an outdated image, so it never wakes idle ones).
 *
 * Throws the first failure's original error only when every install failed,
 * so the refresh-image route can classify it.
 */
export async function refreshCatalogImage(
  catalogItem: InternalMcpCatalog,
  options?: { serverIds?: readonly string[] },
): Promise<void> {
  if (catalogItem.multitenant === true) {
    await reinstallMultitenantCatalog(catalogItem, { freshImagePull: true });
    return;
  }

  const serverIds = options?.serverIds ? new Set(options.serverIds) : null;
  const installs = (
    await McpServerModel.findByCatalogId(catalogItem.id)
  ).filter((server) => !serverIds || serverIds.has(server.id));
  const restartResults = await Promise.allSettled(
    installs.map(async (server) => {
      await McpServerModel.update(server.id, {
        localInstallationStatus: "pending",
        localInstallationError: null,
      });
      broadcastMcpInstallationStatus(server.id, "pending", null);

      try {
        await autoReinstallServer(server, catalogItem, {
          freshImagePull: true,
        });
        await McpServerModel.update(server.id, {
          localInstallationStatus: "success",
          localInstallationError: null,
        });
        broadcastMcpInstallationStatus(server.id, "success", null);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        logger.error(
          { err: error, serverId: server.id, catalogId: catalogItem.id },
          "Pod restart failed for MCP server install",
        );
        await McpServerModel.update(server.id, {
          localInstallationStatus: "error",
          localInstallationError: errorMessage,
        });
        broadcastMcpInstallationStatus(server.id, "error", errorMessage);
        throw error;
      }
    }),
  );
  const failures = restartResults.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0 && failures.length === restartResults.length) {
    // Rethrow the original reason (not a rewrapped Error) so the route can
    // classify it by error name in toMcpOperationApiError.
    throw failures[0].reason;
  }
}
