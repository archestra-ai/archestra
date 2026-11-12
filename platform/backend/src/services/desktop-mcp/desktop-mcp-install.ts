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
  type DesktopMcpArguments,
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
   *
   * `desktopArguments` are the arguments the user adds to the command of the
   * catalog item. When they are not given, an installation the user has
   * keeps its arguments.
   */
  async install(params: {
    catalogItem: Pick<InternalMcpCatalog, "id" | "name" | "desktopConfig">;
    userId: string;
    desktopArguments?: DesktopMcpArguments | null;
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
    const desktopArguments =
      params.desktopArguments === undefined
        ? undefined
        : storedArguments(params.desktopArguments);
    assertCommandForArguments(catalogItem, desktopArguments);
    const existing = await McpServerModel.getUserPersonalServerForCatalog(
      userId,
      catalogItem.id,
    );
    const mcpServer = existing
      ? ((await this.storeArguments(existing, desktopArguments)) ?? existing)
      : await McpServerModel.create({
          name: catalogItem.name,
          catalogId: catalogItem.id,
          serverType: "desktop_mcp",
          userId,
          ownerId: userId,
          scope: "personal",
          localInstallationStatus: "pending",
          desktopArguments: desktopArguments ?? null,
        });
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
   * Stores the arguments a user adds to the command of the catalog item, for
   * the user's own installation, and tells the user's device to get its
   * config again: the MCP bridge stops the MCP server and starts it with the
   * new arguments. The installation waits again until its tools are read
   * from the server that the device started with them.
   *
   * Only the owner of the installation changes its arguments; for any other
   * caller the installation does not exist. Arguments that are the stored
   * ones change nothing and start nothing.
   */
  async updateArguments(params: {
    mcpServerId: string;
    userId: string;
    desktopArguments: DesktopMcpArguments | null;
  }): Promise<McpServer> {
    const { mcpServerId, userId } = params;
    const mcpServer = await McpServerModel.findById(mcpServerId);
    if (
      !mcpServer ||
      mcpServer.serverType !== "desktop_mcp" ||
      mcpServer.scope !== "personal" ||
      mcpServer.ownerId !== userId
    ) {
      throw new ApiError(404, "MCP server not found");
    }
    const desktopArguments = storedArguments(params.desktopArguments);
    const catalogItem = mcpServer.catalogId
      ? await InternalMcpCatalogModel.findById(mcpServer.catalogId, {
          expandSecrets: false,
        })
      : null;
    assertCommandForArguments(catalogItem, desktopArguments);
    const updated = await this.storeArguments(mcpServer, desktopArguments);
    if (!updated) return mcpServer;
    await this.notifyDeviceOfUser(userId);
    return updated;
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

  /**
   * Stores other arguments than the installation has. Returns null, and
   * changes nothing, when they are the stored ones or are not given.
   *
   * The MCP server that runs on the device has the arguments from before.
   * So the installation waits again, the state its device reported for it
   * is not known any more, and the tools are not read for a short time: the
   * device needs it to get its config and stop that MCP server. The caller
   * tells the device to sync.
   */
  private async storeArguments(
    mcpServer: McpServer,
    desktopArguments: DesktopMcpArguments | null | undefined,
  ): Promise<McpServer | null> {
    if (
      desktopArguments === undefined ||
      sameArguments(mcpServer.desktopArguments, desktopArguments)
    ) {
      return null;
    }
    await cacheManager.set(
      attemptKey(mcpServer.id),
      true,
      ARGUMENTS_RESTART_HOLD_MS,
    );
    const updated = await McpServerModel.update(mcpServer.id, {
      desktopArguments,
      localInstallationStatus: "pending",
      localInstallationError: null,
    });
    if (!updated) throw new ApiError(404, "MCP server not found");
    const device = mcpServer.ownerId
      ? await DesktopDeviceModel.findByUserId(mcpServer.ownerId)
      : null;
    if (device && mcpServer.catalogId) {
      await DesktopDeviceServerModel.clearState({
        deviceId: device.id,
        catalogId: mcpServer.catalogId,
      });
    }
    const { broadcastMcpInstallationStatus } = await port(
      "mcpInstallationEvents",
    );
    broadcastMcpInstallationStatus(mcpServer.id, "pending", null);
    return updated;
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
    const key = attemptKey(attempt);
    if (await cacheManager.get<boolean>(key)) return true;
    await cacheManager.set(key, true, ATTEMPT_INTERVAL_MS);
    return false;
  }
}

export const desktopMcpInstallService = new DesktopMcpInstallService();

// === Internal helpers

const ATTEMPT_INTERVAL_MS = 60_000;

/**
 * How long the tools of an installation are not read after its arguments
 * changed. In that time the device gets its config (it is told at once) and
 * stops the MCP server that has the arguments from before: the MCP bridge
 * reads its config file again every 2 seconds. Without the wait, the tools
 * would be read from that MCP server, and the installation would be complete
 * before the one with the new arguments started.
 */
const ARGUMENTS_RESTART_HOLD_MS = 5_000;

function attemptKey(mcpServerId: string) {
  return `${CacheKey.DesktopMcpInstallAttempt}-${mcpServerId}` as const;
}

/** No arguments are stored as null, never as an empty list. */
function storedArguments(
  desktopArguments: DesktopMcpArguments | null,
): DesktopMcpArguments | null {
  return desktopArguments && desktopArguments.length > 0
    ? desktopArguments
    : null;
}

function sameArguments(
  stored: DesktopMcpArguments | null,
  given: DesktopMcpArguments | null,
): boolean {
  const a = stored ?? [];
  const b = given ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Arguments go after a command. A catalog item that is stored with a URL has
 * no command: the device connects to an MCP server that runs already.
 */
function assertCommandForArguments(
  catalogItem: Pick<InternalMcpCatalog, "desktopConfig"> | null,
  desktopArguments: DesktopMcpArguments | null | undefined,
): void {
  if (!desktopArguments || catalogItem?.desktopConfig?.command) return;
  throw new ApiError(
    400,
    "This MCP server has no command, so it takes no arguments.",
  );
}
