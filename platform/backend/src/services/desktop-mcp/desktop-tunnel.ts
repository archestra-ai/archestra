import { createHash } from "node:crypto";
import config from "@/config";
import DesktopDeviceModel from "@/models/desktop-device";
import DesktopMcpRequestModel from "@/models/desktop-mcp-request";
import {
  parseReportedProgram,
  type ReportedProgramValues,
} from "@/services/archestra-cli/served-program";
import type { KeyedNotifier } from "@/services/pg-notify-hub";
import { sharedNotifyHub } from "@/services/shared-notify-hub";
import {
  ApiError,
  type DesktopDevice,
  type DesktopMcpJsonRpcMessage,
  type DesktopMcpRequest,
} from "@/types";

/** A device key is this prefix followed by the sign-in device code. */
export const DESKTOP_DEVICE_KEY_PREFIX = "archestra_dev_";

/**
 * How long a tool call waits for the MCP response of a device. The value is
 * the request deadline of the OpenAI tunnel service, whose protocol the
 * tunnel client speaks.
 */
export const DESKTOP_MCP_REQUEST_DEADLINE_MS = 120_000;

/** Most commands one poll returns, as in the OpenAI tunnel protocol. */
export const DESKTOP_TUNNEL_MAX_COMMANDS_PER_POLL = 25;

/**
 * The tunnel between Archestra and the tunnel client on a desktop device.
 *
 * The device opens every connection: it polls for MCP messages and posts the
 * MCP responses. The queue table is the only state shared between backend
 * copies, so a poll and the tool call it serves can land on different copies.
 * The copy that waits (for work, or for a response) is woken through the
 * shared notify hub when a row changes. A wake-up can be lost, so the waiting
 * copy also reads the table again at a slow interval.
 */
class DesktopTunnelService {
  tunnelIdForDevice(deviceId: string): string {
    return `tunnel_${deviceId.replaceAll("-", "")}`;
  }

  hashDeviceKey(deviceKey: string): string {
    return createHash("sha256").update(deviceKey).digest("hex");
  }

  isOnline(device: Pick<DesktopDevice, "lastPolledAt">): boolean {
    return (
      device.lastPolledAt !== null &&
      Date.now() - device.lastPolledAt.getTime() <=
        DESKTOP_DEVICE_OFFLINE_AFTER_MS
    );
  }

  /** A device that polled at or after this time is online. */
  onlineSince(): Date {
    return new Date(Date.now() - DESKTOP_DEVICE_OFFLINE_AFTER_MS);
  }

  /** Resolves the device a tunnel request speaks for, or rejects the request. */
  async authenticate(params: {
    tunnelId: string;
    deviceKey: string | null;
  }): Promise<DesktopDevice> {
    if (!params.deviceKey?.startsWith(DESKTOP_DEVICE_KEY_PREFIX)) {
      throw new ApiError(401, "A device key is required.");
    }
    const device = await DesktopDeviceModel.findByKeyHash(
      this.hashDeviceKey(params.deviceKey),
    );
    if (!device) {
      throw new ApiError(
        401,
        "This device key is not valid. Sign in the device again.",
      );
    }
    if (this.tunnelIdForDevice(device.id) !== params.tunnelId) {
      throw new ApiError(403, "This device key is for a different tunnel.");
    }
    return device;
  }

  /**
   * Puts one MCP message in the queue of a device. Returns the request id.
   * The message waits for `deadlineMs`, by default the request deadline.
   */
  async enqueue(params: {
    deviceId: string;
    channel: string;
    message: DesktopMcpJsonRpcMessage;
    deadlineMs?: number;
  }): Promise<string> {
    const request = await DesktopMcpRequestModel.create({
      deviceId: params.deviceId,
      channel: params.channel,
      payload: params.message,
      expiresAt: new Date(
        Date.now() + (params.deadlineMs ?? DESKTOP_MCP_REQUEST_DEADLINE_MS),
      ),
    });
    await queueNotifier.notify(params.deviceId);
    return request.id;
  }

  /**
   * Waits for the MCP response of a queued request and removes the request.
   * Returns null when no response came: the deadline passed, the caller
   * stopped waiting, or the device was removed.
   */
  async awaitResponse(params: {
    requestId: string;
    signal: AbortSignal;
  }): Promise<DesktopMcpJsonRpcMessage | null> {
    for (;;) {
      const request = await DesktopMcpRequestModel.findById(params.requestId);
      if (!request) return null;
      if (request.status === "completed") {
        await DesktopMcpRequestModel.delete(request.id);
        return request.response;
      }
      const left = request.expiresAt.getTime() - Date.now();
      if (left <= 0 || params.signal.aborted) {
        await DesktopMcpRequestModel.delete(request.id);
        return null;
      }
      await queueNotifier.wait({
        key: params.requestId,
        timeoutMs: Math.min(QUEUE_RECHECK_MS, left),
        abortSignal: params.signal,
      });
    }
  }

  /**
   * Serves one poll: records that the device is alive and which program it
   * runs, then returns its waiting MCP messages. With an empty queue the poll
   * is held until a message comes or the wait ends.
   */
  async poll(params: {
    device: DesktopDevice;
    /** The program the tunnel client reported, as its headers gave it. */
    program: ReportedProgramValues;
    limit: number;
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<DesktopMcpRequest[]> {
    const { device, signal } = params;
    const reported = parseReportedProgram(params.program);
    const program = {
      clientVersion: reported.version,
      clientTarget: reported.target,
      clientSha256: reported.sha256,
    };
    await Promise.all([
      // The device row changes only when there is something new to store: a
      // device is offline after 35 s, so a poll each few seconds need not
      // write its time each time. A program that just updated itself is
      // something new: the Devices page must show it at once.
      isPollWorthRecording(device) || isProgramChanged(device, program)
        ? DesktopDeviceModel.recordPoll(device.id, program)
        : undefined,
      DesktopMcpRequestModel.deleteExpired(device.id),
    ]);

    const limit = Math.min(params.limit, DESKTOP_TUNNEL_MAX_COMMANDS_PER_POLL);
    const deadline =
      Date.now() + Math.min(params.timeoutMs, config.mcpBridge.pollMaxWaitMs);
    for (;;) {
      // A poll whose connection is gone must not take messages: nobody would
      // receive them.
      if (signal.aborted) return [];
      const claimed = await DesktopMcpRequestModel.claimPending({
        deviceId: device.id,
        limit,
      });
      if (claimed.length > 0) return claimed;
      const left = deadline - Date.now();
      if (left <= 0) return [];
      await queueNotifier.wait({
        key: device.id,
        timeoutMs: Math.min(QUEUE_RECHECK_MS, left),
        abortSignal: signal,
      });
    }
  }

  /**
   * Stores the answer of the tunnel client for one message. Returns false
   * when that message is not waiting for an answer any more.
   */
  async respond(params: {
    device: DesktopDevice;
    requestId: string;
    response: DesktopMcpJsonRpcMessage | null;
    /** An acknowledgment of a notification: no caller waits for it. */
    acknowledgmentOnly: boolean;
  }): Promise<boolean> {
    if (params.acknowledgmentOnly) {
      return DesktopMcpRequestModel.deleteDispatched({
        id: params.requestId,
        deviceId: params.device.id,
      });
    }
    const completed = await DesktopMcpRequestModel.complete({
      id: params.requestId,
      deviceId: params.device.id,
      response: params.response,
    });
    if (completed) await queueNotifier.notify(params.requestId);
    return completed;
  }
}

export const desktopTunnelService = new DesktopTunnelService();

// === Internal helpers

/**
 * A device with no poll for this long is offline. The value is the poll wait
 * of the OpenAI tunnel client (30 s) plus its guard time (5 s).
 */
const DESKTOP_DEVICE_OFFLINE_AFTER_MS = 35_000;

/**
 * How often a waiting backend copy reads the queue again when no wake-up
 * came. Wake-ups are best-effort; this read is what makes the wait correct.
 */
const QUEUE_RECHECK_MS = 2_000;

/** A poll within this time of the stored one is not stored. */
const POLL_RECORD_INTERVAL_MS = 10_000;

/**
 * Wake-ups for the queue, keyed by device id (a message waits for the device)
 * and by request id (the response of a request came).
 */
const queueNotifier: KeyedNotifier = sharedNotifyHub.channel(
  "desktop_mcp_requests",
);

type StoredProgram = Pick<
  DesktopDevice,
  "clientVersion" | "clientTarget" | "clientSha256"
>;

function isProgramChanged(
  device: StoredProgram,
  program: StoredProgram,
): boolean {
  return (
    device.clientVersion !== program.clientVersion ||
    device.clientTarget !== program.clientTarget ||
    device.clientSha256 !== program.clientSha256
  );
}

function isPollWorthRecording(
  device: Pick<DesktopDevice, "lastPolledAt">,
): boolean {
  return (
    device.lastPolledAt === null ||
    Date.now() - device.lastPolledAt.getTime() > POLL_RECORD_INTERVAL_MS
  );
}
