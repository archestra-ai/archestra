import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ErrorCode,
  type JSONRPCMessage,
  JSONRPCMessageSchema,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import DesktopDeviceModel from "@/models/desktop-device";
import DesktopDeviceServerModel from "@/models/desktop-device-server";
import {
  DESKTOP_MCP_REQUEST_DEADLINE_MS,
  desktopTunnelService,
} from "@/services/desktop-mcp/desktop-tunnel";

interface DesktopTunnelTransportParams {
  /** The user whose device takes the messages. */
  userId: string;
  /** Id of the catalog item whose MCP server on the device gets the messages. */
  channel: string;
  /** The name of the catalog item, for the errors a user reads. */
  serverName: string;
}

/**
 * MCP transport to a desktop MCP server: an MCP server on a user's own
 * computer. The backend cannot open a connection to that computer, so a
 * message is put in the queue of the device and the tunnel client there takes
 * it with its next poll and posts the answer back.
 *
 * An MCP client keeps its transport for many calls, and a new sign-in gives
 * the user a new device. So the device of the user is read for each message,
 * not once.
 *
 * Nothing stays open between messages: every message is one queue row, and the
 * tunnel client keeps the MCP session with the server. Several transports (one
 * per backend copy and conversation) can therefore serve the same channel.
 */
export class DesktopTunnelTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private started = false;
  private readonly closing = new AbortController();

  constructor(private readonly params: DesktopTunnelTransportParams) {}

  async start(): Promise<void> {
    if (this.closing.signal.aborted) {
      throw new Error("DesktopTunnelTransport cannot be started after close");
    }
    this.started = true;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.started || this.closing.signal.aborted) {
      throw new Error("DesktopTunnelTransport is not connected");
    }
    const requestId = isRequest(message) ? message.id : null;

    // A device that stopped polling cannot answer. Failing now is better than
    // letting the caller wait for the whole deadline.
    const device = await DesktopDeviceModel.findByUserId(this.params.userId);
    if (!device || !desktopTunnelService.isOnline(device)) {
      if (requestId !== null) {
        this.answerWithError({
          requestId,
          // Not ConnectionClosed: the MCP client would replace the message
          // with its own text and the user would not learn which computer.
          code: ErrorCode.InternalError,
          message: device
            ? `Device "${device.name}" is offline. Start the MCP bridge on that device and try again.`
            : "No device is linked. Set up the MCP bridge on your device from the Device tab of Personal Settings and try again.",
        });
      }
      return;
    }

    // The user stopped this MCP server on the device: say so now, in the
    // user's words, without a trip to the device.
    const notRunning =
      requestId === null ? null : await this.whyNotRunning(device);
    if (requestId !== null && notRunning) {
      this.answerWithError({
        requestId,
        code: ErrorCode.InternalError,
        message: notRunning,
      });
      return;
    }

    const queuedId = await desktopTunnelService.enqueue({
      deviceId: device.id,
      channel: this.params.channel,
      message,
    });
    if (requestId !== null) {
      void this.deliverResponse({
        queuedId,
        requestId,
        deviceName: device.name,
      });
    }
  }

  async close(): Promise<void> {
    if (this.closing.signal.aborted) return;
    this.closing.abort();
    this.onclose?.();
  }

  /**
   * Why the MCP server cannot take a request on the device, or null when
   * Archestra does not know of a reason. Only the user's own Stop counts: it
   * is stored in Archestra. A state that the device reported can be old, so a
   * request for a server that reported a failed start still goes to the
   * device, which answers for itself.
   */
  private async whyNotRunning(device: {
    id: string;
    name: string;
  }): Promise<string | null> {
    const servers = await DesktopDeviceServerModel.findByDeviceId(device.id);
    const server = servers.find((row) => row.catalogId === this.params.channel);
    if (server?.enabled === false) {
      return `${this.params.serverName} is stopped on "${device.name}". Start it on the Devices tab in Personal Settings and try again.`;
    }
    return null;
  }

  private async deliverResponse(params: {
    queuedId: string;
    requestId: RequestId;
    /** Shown in errors, so the user knows which computer did not answer. */
    deviceName: string;
  }): Promise<void> {
    try {
      const response = await desktopTunnelService.awaitResponse({
        requestId: params.queuedId,
        signal: this.closing.signal,
      });
      if (this.closing.signal.aborted) return;
      const parsed = JSONRPCMessageSchema.safeParse(response);
      if (parsed.success && answers(parsed.data, params.requestId)) {
        this.onmessage?.(parsed.data);
        return;
      }
      this.answerWithError({
        requestId: params.requestId,
        code: response ? ErrorCode.InternalError : ErrorCode.RequestTimeout,
        message: response
          ? `Device "${params.deviceName}" returned an answer that is not a valid MCP response.`
          : `Device "${params.deviceName}" did not answer in ${DESKTOP_MCP_REQUEST_DEADLINE_MS / 1000} seconds.`,
      });
    } catch (error) {
      if (this.closing.signal.aborted) return;
      this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      this.answerWithError({
        requestId: params.requestId,
        code: ErrorCode.InternalError,
        message: `The answer of device "${params.deviceName}" could not be read.`,
      });
    }
  }

  /** Ends one request with a JSON-RPC error, as an MCP server would. */
  private answerWithError(params: {
    requestId: RequestId;
    code: number;
    message: string;
  }): void {
    // Not in the same tick: the SDK registers its response handler only after
    // send() resolves.
    queueMicrotask(() => {
      if (this.closing.signal.aborted) return;
      this.onmessage?.({
        jsonrpc: "2.0",
        id: params.requestId,
        error: { code: params.code, message: params.message },
      });
    });
  }
}

// === Internal helpers

function isRequest(
  message: JSONRPCMessage,
): message is JSONRPCMessage & { id: RequestId; method: string } {
  return "method" in message && "id" in message;
}

/** Whether a message is the result or the error of the given request. */
function answers(message: JSONRPCMessage, requestId: RequestId): boolean {
  return !("method" in message) && "id" in message && message.id === requestId;
}
