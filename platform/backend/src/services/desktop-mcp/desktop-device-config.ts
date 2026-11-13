import { isMcpInstallationAdmin } from "@/auth/mcp-catalog-permissions";
import { userHasPermission } from "@/auth/utils";
import DesktopDeviceServerModel from "@/models/desktop-device-server";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import McpServerModel from "@/models/mcp-server";
import type { DesktopDevice, DesktopMcpServerState } from "@/types";

/**
 * One MCP server of a device: the catalog item, whether the user stopped it
 * on this device, and the state the tunnel client reported.
 */
export interface DesktopDeviceServerConfig {
  catalogId: string;
  name: string;
  /** The command of the catalog item. A server has a command or a URL. */
  command: string | null;
  /** The URL of the catalog item. */
  url: string | null;
  /** False after the user stopped the MCP server. */
  enabled: boolean;
  reportedState: DesktopMcpServerState | null;
  lastError: string | null;
  /** How many tools Archestra has stored for the catalog item. */
  toolCount: number;
}

/**
 * The MCP servers of a device: one for each desktop MCP catalog item that its
 * user installed and can still use. A catalog item the user did not install
 * does not run on their device.
 */
export async function listDesktopDeviceServerConfigs(
  device: Pick<DesktopDevice, "id" | "userId" | "organizationId">,
): Promise<DesktopDeviceServerConfig[]> {
  // Starts from the user's own installations, a handful, not from the whole
  // registry: this runs for each sync of a device and each Devices page read.
  const installs = await McpServerModel.getUserPersonalServersOfType(
    device.userId,
    "desktop_mcp",
  );
  const installedIds = installs.flatMap((install) =>
    install.catalogId ? [install.catalogId] : [],
  );
  if (installedIds.length === 0) return [];

  const [usableIds, rows] = await Promise.all([
    usableCatalogIds(device),
    DesktopDeviceServerModel.findByDeviceId(device.id),
  ]);
  const items = await InternalMcpCatalogModel.getByIds(
    installedIds.filter((id) => usableIds.has(id)),
    { expandSecrets: false },
  );
  const rowByCatalogId = new Map(rows.map((row) => [row.catalogId, row]));
  return [...items.values()]
    .filter((item) => item.serverType === "desktop_mcp")
    .map((item) => {
      const row = rowByCatalogId.get(item.id);
      return {
        catalogId: item.id,
        name: item.name,
        command: item.desktopConfig?.command ?? null,
        url: item.desktopConfig?.url ?? null,
        enabled: row?.enabled ?? true,
        reportedState: row?.state ?? null,
        lastError: row?.lastError ?? null,
        toolCount: item.toolCount,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// === Internal helpers

/** The catalog items the user can use, as the MCP registry lists them for that user. */
async function usableCatalogIds(params: {
  userId: string;
  organizationId: string;
}): Promise<Set<string>> {
  const { userId, organizationId } = params;
  const [isAdmin, canReadRegistry] = await Promise.all([
    isMcpInstallationAdmin(params),
    userHasPermission(userId, organizationId, "mcpRegistry", "read"),
  ]);
  return new Set(
    await InternalMcpCatalogModel.findAccessibleIds({
      userId,
      isAdmin,
      organizationId,
      readGrantContext: canReadRegistry
        ? undefined
        : { userId, organizationId },
    }),
  );
}
