import config from "@/config";
import logger from "@/logging";
import AuditLogModel from "@/models/audit-log";
import DesktopDeviceModel from "@/models/desktop-device";
import DesktopDeviceServerModel from "@/models/desktop-device-server";
import McpServerModel from "@/models/mcp-server";
import UserModel from "@/models/user";
import { reportAuditWriteFailure } from "@/observability/metrics/audit";
import { servedProgramService } from "@/services/archestra-cli/served-program";
import {
  ApiError,
  type ConnectionSetupPlatform,
  type DesktopDevice,
  type DesktopMcpServerState,
} from "@/types";
import {
  extractAuditResourceName,
  sanitizeAuditSnapshot,
} from "@/utils/audit-snapshot";
import { desktopBridgeControlService } from "./desktop-bridge-control";
import {
  type DesktopDeviceServerConfig,
  listDesktopDeviceServerConfigs,
} from "./desktop-device-config";
import { desktopTunnelService } from "./desktop-tunnel";

export interface DesktopDeviceServerView {
  catalogId: string;
  name: string;
  /**
   * The state of the MCP server. Null when it is not known: the device is
   * offline, or its tunnel client did not report yet.
   */
  state: DesktopMcpServerState | null;
  lastError: string | null;
  command: string | null;
  url: string | null;
  enabled: boolean;
  toolCount: number;
}

export interface DesktopDeviceView {
  id: string;
  name: string;
  platform: ConnectionSetupPlatform;
  online: boolean;
  lastPolledAt: Date | null;
  createdAt: Date;
  /** The version of the MCP bridge the device reported, or null with none. */
  programVersion: string | null;
  /**
   * Set when Archestra serves another program for the device's target than
   * the one the device runs. `version` is the served version, null when it is
   * not known.
   */
  programUpdate: { version: string | null } | null;
  /** Whether the MCP bridge of a device updates by itself (auto-update). */
  programAutoUpdate: boolean;
  /** One MCP server for each desktop MCP catalog item the user installed. */
  servers: DesktopDeviceServerView[];
}

/** The devices of a user, as the Devices page shows them. */
export async function listDesktopDevicesForUser(params: {
  userId: string;
}): Promise<DesktopDeviceView[]> {
  const device = await DesktopDeviceModel.findByUserId(params.userId);
  if (!device) return [];
  return [await toView(device)];
}

/** The device of a user, or a 404: a user reaches their own device only. */
export async function getDesktopDeviceOfUser(params: {
  id: string;
  userId: string;
}): Promise<DesktopDevice> {
  const device = await DesktopDeviceModel.findById(params.id);
  if (!device || device.userId !== params.userId) {
    throw new ApiError(404, "Device not found");
  }
  return device;
}

/**
 * Stores whether the user started or stopped one MCP server on their device,
 * then tells the tunnel client to get its config again.
 */
export async function updateDesktopDeviceServer(params: {
  device: DesktopDevice;
  catalogId: string;
  enabled: boolean;
}): Promise<DesktopDeviceView> {
  const { device } = params;
  await assertServerOfDevice(device, params.catalogId);
  await DesktopDeviceServerModel.saveEnabled({
    deviceId: device.id,
    catalogId: params.catalogId,
    enabled: params.enabled,
  });
  await desktopBridgeControlService.notifySync([device.id]);
  return toView(device);
}

/**
 * Removes a device when its own tunnel client asks for that, with the device
 * key and no session. The audit hook covers only `/api/*` routes with a
 * session, so this writes the record the hook writes when the user removes
 * the device on the Devices page: `desktopDevice.deleted`, by the user who
 * owns the device.
 */
export async function removeDesktopDeviceForTunnelClient(params: {
  device: DesktopDevice;
  request: {
    id: string;
    method: string;
    /** The path of the request, with no query string. */
    path: string;
    route: string | null;
    sourceIp: string | null;
    userAgent: string | null;
  };
}): Promise<void> {
  const { device, request } = params;
  const occurredAt = new Date();
  const [before, owner] = await Promise.all([
    DesktopDeviceModel.findByIdForAudit(device.id, device.organizationId),
    UserModel.getById(device.userId),
  ]);
  const removed = await DesktopDeviceModel.deleteForUser({
    id: device.id,
    userId: device.userId,
  });
  // Removed by another request since this one was authenticated: the device
  // is gone, as the tunnel client asked, and that request has the record.
  if (!removed) return;

  const snapshot = sanitizeAuditSnapshot(before);
  await AuditLogModel.create({
    organizationId: device.organizationId,
    actorId: device.userId,
    actorType: "user",
    actorName: owner?.name ?? null,
    actorEmail: owner?.email ?? null,
    action: "desktopDevice.deleted",
    outcome: "success",
    resourceType: "desktopDevice",
    resourceId: device.id,
    resourceName: extractAuditResourceName(null, snapshot),
    before: snapshot,
    after: null,
    httpMethod: request.method,
    httpPath: request.path,
    httpRoute: request.route,
    httpStatus: 200,
    requestId: request.id,
    sourceIp: request.sourceIp,
    userAgent: request.userAgent,
    occurredAt,
  }).catch((err) => {
    logger.error({ err }, "audit: failed to write audit log row");
    reportAuditWriteFailure({ source: "http", resourceType: "desktopDevice" });
  });
}

/** Rejects a catalog item that is not an MCP server of this device. */
export async function assertServerOfDevice(
  device: DesktopDevice,
  catalogId: string,
): Promise<void> {
  const installation = await McpServerModel.getUserPersonalServerForCatalog(
    device.userId,
    catalogId,
  );
  if (installation?.serverType !== "desktop_mcp") {
    throw new ApiError(404, "MCP server not found on this device");
  }
}

// === Internal helpers

async function toView(device: DesktopDevice): Promise<DesktopDeviceView> {
  const online = desktopTunnelService.isOnline(device);
  const [servers, programUpdate] = await Promise.all([
    listDesktopDeviceServerConfigs(device),
    findProgramUpdate(device),
  ]);
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    online,
    lastPolledAt: device.lastPolledAt,
    createdAt: device.createdAt,
    programVersion: device.clientVersion,
    programUpdate,
    programAutoUpdate: config.mcpBridge.autoUpdateEnabled,
    servers: servers.map((server) => toServerView(server, online)),
  };
}

/**
 * The program Archestra serves for the device's target when it is not the
 * one the device runs: the two files differ by their SHA-256. Null when the
 * device did not report its target and SHA-256, and when Archestra has no
 * file for the target.
 */
async function findProgramUpdate(
  device: Pick<DesktopDevice, "clientTarget" | "clientSha256">,
): Promise<DesktopDeviceView["programUpdate"]> {
  if (!device.clientTarget || !device.clientSha256) return null;
  const served = await servedProgramService.getServedProgram(
    device.clientTarget,
  );
  if (!served || served.sha256 === device.clientSha256) return null;
  return { version: served.version };
}

function toServerView(
  server: DesktopDeviceServerConfig,
  online: boolean,
): DesktopDeviceServerView {
  const state = shownState(server, online);
  return {
    catalogId: server.catalogId,
    name: server.name,
    state,
    lastError: state === "failed" ? server.lastError : null,
    command: server.command,
    url: server.url,
    enabled: server.enabled,
    toolCount: server.toolCount,
  };
}

/**
 * The state to show. What Archestra itself knows wins over the last report:
 * a server with no command cannot run, and a stopped one stays stopped. The
 * report of a device that is offline is not shown; it can be old.
 */
function shownState(
  server: DesktopDeviceServerConfig,
  online: boolean,
): DesktopMcpServerState | null {
  if (!server.command && !server.url) return "no_command";
  if (!server.enabled) return "stopped";
  if (!online) return null;
  return server.reportedState;
}
