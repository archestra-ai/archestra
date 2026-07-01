import mcpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
import logger from "@/logging";
import { McpServerModel } from "@/models";

// === Public API ===

export async function reconcileCatalogDeployments(params: {
  catalogs: { id: string; multitenant: boolean }[];
  reason: string;
}): Promise<void> {
  const { catalogs, reason } = params;
  const servers = await McpServerModel.findByCatalogIds(
    catalogs.map((catalog) => catalog.id),
  );
  const multitenantCatalogIds = new Set(
    catalogs
      .filter((catalog) => catalog.multitenant)
      .map((catalog) => catalog.id),
  );
  const singleTenantServers = servers.filter(
    (server) =>
      server.catalogId && !multitenantCatalogIds.has(server.catalogId),
  );

  await Promise.allSettled([
    ...singleTenantServers.map(async (server) => {
      try {
        await mcpServerRuntimeManager.restartServer(server.id);
      } catch (err) {
        logger.warn(
          { mcpServerId: server.id, err, reason },
          "Failed to restart server after environment deployment setting change",
        );
      }
    }),
    ...[...multitenantCatalogIds].map(async (catalogId) => {
      try {
        await mcpServerRuntimeManager.reinstallSharedDeployment(catalogId);
      } catch (err) {
        logger.warn(
          { catalogId, err, reason },
          "Failed to reinstall shared deployment after environment deployment setting change",
        );
      }
    }),
  ]);
}
