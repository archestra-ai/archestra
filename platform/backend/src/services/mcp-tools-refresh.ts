import config from "@/config";
import logger from "@/logging";
import { McpServerModel } from "@/models";
import { reloadToolsForServer } from "@/services/mcp-reinstall";

/**
 * Opt-in periodic re-discovery of installed MCP servers' tools.
 *
 * When `ARCHESTRA_MCP_SERVER_TOOLS_REFRESH_INTERVAL_MINUTES` is set (> 0),
 * every tick re-syncs each installed catalog's tool snapshot from the live
 * server — the same add/update/remove reconciliation as the reload-tools
 * endpoint, with no pod restart. Tool rows are shared per catalog item, so
 * one install per catalog is refreshed. A failing server is logged and
 * skipped; it never blocks the rest of the sweep.
 *
 * The in-process sweepInProgress guard only prevents tick stacking within one
 * process. In a multi-replica deployment every backend pod sweeps
 * independently — safe, because the sync is idempotent (same live tool list
 * reconciles to the same rows), just redundant upstream `tools/list` calls.
 */
class McpToolsRefreshManager {
  private intervalId: NodeJS.Timeout | null = null;
  private sweepInProgress = false;

  start(): void {
    const intervalMinutes = config.mcpServer.toolsRefreshIntervalMinutes;
    if (intervalMinutes <= 0 || this.intervalId) {
      return;
    }
    this.intervalId = setInterval(
      () => {
        void this.refreshAll();
      },
      intervalMinutes * 60 * 1000,
    );
    // Never keep the process alive just for the refresher.
    this.intervalId.unref();
    logger.info({ intervalMinutes }, "Periodic MCP tools refresh enabled");
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * One full sweep — what each interval tick runs. Public so a sweep can be
   * triggered directly (tests, future operator surfaces) without waiting for
   * the timer.
   */
  async refreshAll(): Promise<void> {
    // A slow sweep (many servers, slow upstreams) must not stack onto the
    // next tick; skip the tick and let the running sweep finish.
    if (this.sweepInProgress) {
      return;
    }
    this.sweepInProgress = true;
    try {
      const servers = await McpServerModel.findOnePerCatalogForToolsRefresh();
      for (const server of servers) {
        try {
          const result = await reloadToolsForServer(server);
          if (result.created || result.updated || result.deleted) {
            logger.info(
              { serverId: server.id, serverName: server.name, ...result },
              "Periodic MCP tools refresh updated the tool catalog",
            );
          }
        } catch (error) {
          // An unreachable/broken server must not abort the sweep.
          logger.warn(
            { err: error, serverId: server.id, serverName: server.name },
            "Periodic MCP tools refresh failed for server",
          );
        }
      }
    } catch (error) {
      logger.error({ err: error }, "Periodic MCP tools refresh sweep failed");
    } finally {
      this.sweepInProgress = false;
    }
  }
}

export const mcpToolsRefreshManager = new McpToolsRefreshManager();
