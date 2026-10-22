import logger from "@/logging";
import { McpServerModel } from "@/models";
import { trackBackgroundWork } from "@/utils/background-work";

/**
 * Re-syncs a catalog's tool snapshot when an installed MCP server announces
 * `notifications/tools/list_changed`.
 *
 * The platform's MCP client registers {@link onToolListChanged} on every
 * connection it holds to an installed server, so this only hears servers that
 * currently have an open connection (an idle-evicted or never-used install
 * announces nothing; the reload endpoint and the periodic refresher still
 * cover those).
 *
 * Tool rows are shared per catalog item, and a multi-tenant catalog's shared
 * pod may announce the same change on every install's session. Notifications
 * are therefore coalesced per catalog: the first one opens a short window,
 * and everything that arrives inside it rides on the single re-sync that runs
 * when the window closes. Re-syncs of one catalog run one at a time, so a
 * change announced mid-sync is picked up by the next one rather than lost.
 *
 * Re-syncing goes through `reloadToolsForServer` without waking a hibernated
 * deployment. Failures are logged and dropped; they never reach the
 * connection or the request that was in flight when the notification came.
 */
class McpToolListChangedSync {
  private static readonly COALESCE_WINDOW_MS = 1_000;

  // Catalogs with an open coalescing window. Scheduling state, not a cache:
  // an entry lives for exactly one window and is bounded by catalog count.
  private pendingCatalogIds = new Set<string>();
  // Tail of each catalog's re-sync chain, so syncs of one catalog never
  // overlap. Removed once the chain drains.
  private syncChains = new Map<string, Promise<void>>();

  /**
   * Schedule a coalesced re-sync of the catalog `mcpServerId` belongs to.
   * Never throws; the work is tracked for shutdown and test teardown.
   */
  onToolListChanged(mcpServerId: string): void {
    trackBackgroundWork(this.coalesce(mcpServerId));
  }

  private async coalesce(mcpServerId: string): Promise<void> {
    try {
      const server = await McpServerModel.findById(mcpServerId);
      const catalogId = server?.catalogId;
      if (!catalogId || this.pendingCatalogIds.has(catalogId)) {
        return;
      }
      this.pendingCatalogIds.add(catalogId);
      await sleep(McpToolListChangedSync.COALESCE_WINDOW_MS);
      this.pendingCatalogIds.delete(catalogId);
      await this.enqueueSync({ catalogId, mcpServerId });
    } catch (error) {
      logger.warn(
        { err: error, mcpServerId },
        "Failed to schedule MCP tools re-sync after tools/list_changed",
      );
    }
  }

  private async enqueueSync(params: {
    catalogId: string;
    mcpServerId: string;
  }): Promise<void> {
    const { catalogId, mcpServerId } = params;
    const previous = this.syncChains.get(catalogId) ?? Promise.resolve();
    const run = previous.then(() => this.resync(mcpServerId));
    this.syncChains.set(catalogId, run);
    try {
      await run;
    } finally {
      if (this.syncChains.get(catalogId) === run) {
        this.syncChains.delete(catalogId);
      }
    }
  }

  private async resync(mcpServerId: string): Promise<void> {
    try {
      // Re-read: the install may have been removed while the window was open.
      const server = await McpServerModel.findById(mcpServerId);
      if (!server) {
        return;
      }
      // Dynamic import: mcp-reinstall reaches back into the MCP client.
      const { reloadToolsForServer } = await import("@/services/mcp-reinstall");
      const result = await reloadToolsForServer(
        server,
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        { wake: false },
        // SPDX-SnippetEnd
      );
      if (result.created || result.updated || result.deleted) {
        logger.info(
          { serverId: server.id, serverName: server.name, ...result },
          "MCP server announced a tool change; tool catalog re-synced",
        );
      }
    } catch (error) {
      logger.warn(
        { err: error, mcpServerId },
        "MCP tools re-sync after tools/list_changed failed",
      );
    }
  }
}

export const mcpToolListChangedSync = new McpToolListChangedSync();

// =============================================================================
// Internal helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
