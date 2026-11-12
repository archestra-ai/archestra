import { z } from "zod";
import DesktopDeviceModel from "@/models/desktop-device";
import DesktopDeviceServerModel from "@/models/desktop-device-server";
import {
  ApiError,
  type DesktopDevice,
  type DesktopMcpJsonRpcMessage,
  DesktopMcpServerStateSchema,
  type InternalMcpCatalogServerType,
} from "@/types";
import { desktopTunnelService } from "./desktop-tunnel";

/**
 * The reserved channel of the tunnel: its messages are for the tunnel client
 * itself, not for an MCP server. A catalog item id is a UUID, so no catalog
 * item has this channel.
 */
export const DESKTOP_BRIDGE_CHANNEL = "archestra-bridge";

/** The method of the state report that the tunnel client sends. */
const DESKTOP_BRIDGE_STATE_METHOD = "bridge/state";

/**
 * What Archestra asks of the tunnel client itself, and what the tunnel client
 * reports about itself. The requests travel through the queue, as an MCP
 * request does: Archestra never opens a connection to a device.
 */
class DesktopBridgeControlService {
  /**
   * Tells tunnel clients to get their config again. It does not wait: a
   * device that is offline misses the message and syncs when it starts.
   */
  async notifySync(deviceIds: string[]): Promise<void> {
    await Promise.all(
      deviceIds.map((deviceId) =>
        desktopTunnelService.enqueue({
          deviceId,
          channel: DESKTOP_BRIDGE_CHANNEL,
          message: { jsonrpc: "2.0", method: "bridge/sync" },
        }),
      ),
    );
  }

  /**
   * A catalog item was created, changed, removed or restored. If it is a
   * desktop MCP server, every tunnel client of its organization gets its
   * config again: the item can be one of theirs.
   */
  async notifyCatalogItemChanged(catalogItem: {
    serverType: InternalMcpCatalogServerType;
    organizationId: string | null;
  }): Promise<void> {
    if (catalogItem.serverType !== "desktop_mcp") return;
    if (!catalogItem.organizationId) return;
    // Only the devices that are online: an offline one syncs when it starts,
    // and a message for it would wait in the queue for nothing.
    await this.notifySync(
      await DesktopDeviceModel.findIdsPolledSince({
        organizationId: catalogItem.organizationId,
        since: desktopTunnelService.onlineSince(),
      }),
    );
  }

  async restartServer(params: {
    device: DesktopDevice;
    catalogId: string;
  }): Promise<void> {
    await this.call({
      device: params.device,
      channel: DESKTOP_BRIDGE_CHANNEL,
      method: "bridge/server/restart",
      params: { channel: params.catalogId },
    });
  }

  /** The last lines the MCP server wrote to stderr on the device. */
  async readServerLog(params: {
    device: DesktopDevice;
    catalogId: string;
  }): Promise<string[]> {
    const result = await this.call({
      device: params.device,
      channel: DESKTOP_BRIDGE_CHANNEL,
      method: "bridge/server/log",
      params: { channel: params.catalogId },
    });
    return parseResult(LogResultSchema, result).lines;
  }

  /**
   * Asks the MCP server of a catalog item for its tool list, through the
   * tunnel, and counts the tools. Nothing is stored.
   */
  async testServer(params: {
    device: DesktopDevice;
    catalogId: string;
  }): Promise<{ toolCount: number; durationMs: number }> {
    const startedAt = Date.now();
    let toolCount = 0;
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
      const result = parseResult(
        ToolListResultSchema,
        await this.call({
          device: params.device,
          channel: params.catalogId,
          method: "tools/list",
          params: cursor ? { cursor } : {},
        }),
      );
      toolCount += result.tools.length;
      cursor = result.nextCursor ?? undefined;
      if (!cursor) break;
    }
    return { toolCount, durationMs: Date.now() - startedAt };
  }

  /**
   * Stores a state report of the tunnel client. A report that does not have
   * the expected shape is dropped: a newer tunnel client must not break an
   * older Archestra. Keys the schema does not know, such as the
   * `permissions` of an older tunnel client, are ignored.
   *
   * Returns the catalog items whose MCP server the report says is running:
   * an installation that waits for its MCP server can be completed now.
   */
  async recordState(params: {
    device: DesktopDevice;
    message: DesktopMcpJsonRpcMessage;
  }): Promise<string[]> {
    const parsed = StateReportSchema.safeParse(params.message);
    if (!parsed.success) return [];
    const { servers } = parsed.data.params;
    await DesktopDeviceServerModel.recordStates({
      deviceId: params.device.id,
      states: servers.map((server) => ({
        catalogId: server.channel,
        state: server.state,
        lastError: server.error ?? null,
      })),
    });
    return servers
      .filter((server) => server.state === "running")
      .map((server) => server.channel);
  }

  /**
   * Sends one JSON-RPC request to the device and waits for the answer.
   * Returns the `result` of the answer.
   */
  private async call(params: {
    device: DesktopDevice;
    channel: string;
    method: string;
    params: Record<string, unknown>;
  }): Promise<unknown> {
    const { device } = params;
    if (!desktopTunnelService.isOnline(device)) {
      throw new ApiError(
        409,
        `Device "${device.name}" is offline. Start the MCP bridge on that device and try again.`,
      );
    }
    const requestId = await desktopTunnelService.enqueue({
      deviceId: device.id,
      channel: params.channel,
      message: {
        jsonrpc: "2.0",
        id: CONTROL_REQUEST_ID,
        method: params.method,
        params: params.params,
      },
      deadlineMs: CONTROL_REQUEST_DEADLINE_MS,
    });
    const response = await desktopTunnelService.awaitResponse({
      requestId,
      signal: AbortSignal.timeout(CONTROL_REQUEST_DEADLINE_MS),
    });
    if (!response) {
      throw new ApiError(
        504,
        `Device "${device.name}" did not answer. Check that the MCP bridge is in operation.`,
      );
    }
    const answer = AnswerSchema.safeParse(response);
    if (!answer.success) {
      throw new ApiError(
        502,
        "The MCP bridge gave an answer that is not valid.",
      );
    }
    if (answer.data.error) {
      throw new ApiError(502, answer.data.error.message);
    }
    return answer.data.result;
  }
}

export const desktopBridgeControlService = new DesktopBridgeControlService();

// === Internal helpers

/**
 * How long the user of the Devices page waits for the tunnel client. A device
 * that polls answers in less than a second.
 */
const CONTROL_REQUEST_DEADLINE_MS = 15_000;

/** One request waits for one answer on its own queue row, so the id is fixed. */
const CONTROL_REQUEST_ID = 1;

const MAX_TOOL_LIST_PAGES = 20;
const MAX_REPORTED_SERVERS = 256;
const MAX_ERROR_LENGTH = 2000;

const AnswerSchema = z.object({
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

const LogResultSchema = z.object({ lines: z.array(z.string()) });

const ToolListResultSchema = z.object({
  tools: z.array(z.unknown()),
  nextCursor: z.string().nullish(),
});

const StateReportSchema = z.object({
  method: z.literal(DESKTOP_BRIDGE_STATE_METHOD),
  params: z.object({
    servers: z
      .array(
        z.object({
          channel: z.string().uuid(),
          state: DesktopMcpServerStateSchema,
          error: z.string().max(MAX_ERROR_LENGTH).nullish(),
        }),
      )
      .max(MAX_REPORTED_SERVERS),
  }),
});

function parseResult<T>(schema: z.ZodType<T>, result: unknown): T {
  const parsed = schema.safeParse(result);
  if (!parsed.success) {
    throw new ApiError(502, "The MCP bridge gave an answer that is not valid.");
  }
  return parsed.data;
}
