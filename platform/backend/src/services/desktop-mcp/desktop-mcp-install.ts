import { isMcpInstallationAdmin } from "@/auth/mcp-catalog-permissions";
import { CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import AgentModel from "@/models/agent";
import AgentToolModel from "@/models/agent-tool";
import DesktopDeviceModel from "@/models/desktop-device";
import DesktopDeviceServerModel from "@/models/desktop-device-server";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import McpServerModel from "@/models/mcp-server";
import { port } from "@/models/ports";
import {
  ApiError,
  type DesktopDevice,
  type InternalMcpCatalog,
  type McpServer,
} from "@/types";
import { isUuid } from "@/utils/uuid";
import { desktopBridgeControlService } from "./desktop-bridge-control";
import { syncDesktopMcpTools } from "./desktop-mcp-tools";

/**
 * The installations of desktop MCP catalog items. An installation is always
 * personal: it puts the MCP server in the config of its owner's tunnel client.
 * Install creates it waiting, because the MCP server starts on the device only
 * after the installation exists; it is complete when the tunnel client reports
 * the MCP server in operation and its tools are read through the tunnel.
 */
class DesktopMcpInstallService {
  /** Installations whose tool discovery is in progress in this backend copy. */
  private readonly inProgress = new Set<string>();

  /**
   * Creates the waiting installation of a catalog item for a user, or returns
   * the one the user has, and tells the user's device to get its config
   * again. Install also clears a Stop the user stored for the MCP server on
   * the Devices tab: the user asked for it to run. Works with no device: the
   * first sync of a new device brings the MCP server.
   */
  async install(params: {
    catalogItem: Pick<InternalMcpCatalog, "id" | "name" | "desktopConfig">;
    userId: string;
  }): Promise<McpServer> {
    const { catalogItem, userId } = params;
    if (
      !catalogItem.desktopConfig?.command &&
      !catalogItem.desktopConfig?.url
    ) {
      throw new ApiError(
        400,
        "This MCP server has no command and no URL, so there is nothing to run on a computer.",
      );
    }
    const existing = await McpServerModel.getUserPersonalServerForCatalog(
      userId,
      catalogItem.id,
    );
    const mcpServer =
      existing ??
      (await McpServerModel.create({
        name: catalogItem.name,
        catalogId: catalogItem.id,
        serverType: "desktop_mcp",
        userId,
        ownerId: userId,
        scope: "personal",
        localInstallationStatus: "pending",
      }));
    const device = await DesktopDeviceModel.findByUserId(userId);
    if (device) {
      await DesktopDeviceServerModel.saveEnabled({
        deviceId: device.id,
        catalogId: catalogItem.id,
        enabled: true,
      });
      await desktopBridgeControlService.notifySync([device.id]);
    }
    return mcpServer;
  }

  /**
   * A user's installations changed (uninstall, restore): their device gets
   * its config again, so the MCP server stops or starts.
   */
  async notifyDeviceOfUser(userId: string | null): Promise<void> {
    if (!userId) return;
    const device = await DesktopDeviceModel.findByUserId(userId);
    if (device) await desktopBridgeControlService.notifySync([device.id]);
  }

  /**
   * Called on every poll with the channels the device reports as ready. Does
   * not wait for the tool discovery and never throws: reading the tools needs
   * the device to keep polling, and a failure must not fail the poll.
   */
  completeReadyChannels(device: DesktopDevice, readyChannels: string[]): void {
    const catalogIds = readyChannels.filter(isUuid);
    if (catalogIds.length === 0) return;
    void this.completeWaiting(device, catalogIds).catch((error) => {
      logger.error(
        { err: error, deviceId: device.id },
        "Could not complete a desktop MCP installation",
      );
    });
  }

  /**
   * Completes each waiting installation the device owner has among the given
   * catalog items. Resolves when every attempt has ended.
   */
  async completeWaiting(
    device: DesktopDevice,
    catalogIds: string[],
  ): Promise<void> {
    const own = await McpServerModel.getUserPersonalServersForCatalogs(
      device.userId,
      catalogIds,
    );
    const waiting = [...own.values()].filter(
      (install) =>
        install.serverType === "desktop_mcp" &&
        install.localInstallationStatus !== "success",
    );
    for (const install of waiting) {
      if (this.inProgress.has(install.id)) continue;
      this.inProgress.add(install.id);
      try {
        if (await this.attemptedRecently(install.id)) continue;
        await this.discoverTools(device, install);
      } finally {
        this.inProgress.delete(install.id);
      }
    }
  }

  private async discoverTools(
    device: DesktopDevice,
    mcpServer: McpServer,
  ): Promise<void> {
    if (!mcpServer.catalogId) return;
    const catalogItem = await InternalMcpCatalogModel.findById(
      mcpServer.catalogId,
      {
        accessAction: "use",
        expandSecrets: false,
        userId: device.userId,
        organizationId: device.organizationId,
        isAdmin: await isMcpInstallationAdmin({
          userId: device.userId,
          organizationId: device.organizationId,
        }),
      },
    );
    // The owner lost the access to the catalog item: the installation waits.
    if (!catalogItem || catalogItem.serverType !== "desktop_mcp") return;

    await this.setStatus(mcpServer.id, "discovering-tools");
    try {
      const tools = await McpServerModel.getToolsFromServer(mcpServer);
      const { created, unchanged } = await syncDesktopMcpTools({
        mcpServerId: mcpServer.id,
        catalogItem,
        tools,
      });
      const syncedTools = [...created, ...unchanged];
      // As each other personal install does: the tools go to the owner's
      // personal MCP gateway, bound to this install.
      if (syncedTools.length > 0) {
        const personalGateway = await AgentModel.ensurePersonalMcpGateway({
          userId: device.userId,
          organizationId: device.organizationId,
        });
        await AgentToolModel.bulkCreateForAgentsAndTools(
          [personalGateway.id],
          syncedTools.map((tool) => tool.id),
          { mcpServerId: mcpServer.id, credentialResolutionMode: "static" },
        );
      }
      await this.setStatus(mcpServer.id, "success");
      logger.info(
        {
          mcpServerId: mcpServer.id,
          catalogId: catalogItem.id,
          deviceId: device.id,
          toolCount: syncedTools.length,
        },
        "Completed a desktop MCP installation",
      );
    } catch (error) {
      // The installation stays and waits: the next attempt reads the tools.
      await this.setStatus(mcpServer.id, "pending");
      logger.warn(
        { err: error, mcpServerId: mcpServer.id, deviceId: device.id },
        "Could not read the tools of a desktop MCP server; it will be tried again",
      );
    }
  }

  private async setStatus(
    mcpServerId: string,
    status: "pending" | "discovering-tools" | "success",
  ): Promise<void> {
    await McpServerModel.update(mcpServerId, {
      localInstallationStatus: status,
      localInstallationError: null,
    });
    const { broadcastMcpInstallationStatus } = await port(
      "mcpInstallationEvents",
    );
    broadcastMcpInstallationStatus(mcpServerId, status, null);
  }

  /**
   * Spaces out the attempts for one installation, so a server that cannot
   * list its tools is not asked again on every poll.
   */
  private async attemptedRecently(attempt: string): Promise<boolean> {
    const key = `${CacheKey.DesktopMcpInstallAttempt}-${attempt}` as const;
    if (await cacheManager.get<boolean>(key)) return true;
    await cacheManager.set(key, true, ATTEMPT_INTERVAL_MS);
    return false;
  }
}

export const desktopMcpInstallService = new DesktopMcpInstallService();

// === Internal helpers

const ATTEMPT_INTERVAL_MS = 60_000;
