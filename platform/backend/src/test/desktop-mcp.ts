import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import DesktopDeviceModel from "@/models/desktop-device";
import {
  DESKTOP_DEVICE_KEY_PREFIX,
  desktopTunnelService,
} from "@/services/desktop-mcp/desktop-tunnel";
import type { DesktopDevice, DesktopMcpJsonRpcMessage } from "@/types";

export interface TestDevice {
  device: DesktopDevice;
  deviceKey: string;
  tunnelId: string;
  /** The bearer header the tunnel client of this device sends. */
  headers: { authorization: string };
}

/** Registers a device for a user, as an approved sign-in does. */
export async function connectTestDevice(params: {
  organizationId: string;
  userId: string;
  name?: string;
}): Promise<TestDevice> {
  const deviceKey = `${DESKTOP_DEVICE_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  const device = await DesktopDeviceModel.replaceForUser({
    organizationId: params.organizationId,
    userId: params.userId,
    name: params.name ?? "MBP-0142",
    platform: "macos",
    keyHash: desktopTunnelService.hashDeviceKey(deviceKey),
  });
  return {
    device,
    deviceKey,
    tunnelId: desktopTunnelService.tunnelIdForDevice(device.id),
    headers: { authorization: `Bearer ${deviceKey}` },
  };
}

/**
 * Gives every test of the file its own download folder for the `archestra`
 * programs, empty at first. `writeProgram` puts the file of one target in it
 * and returns the SHA-256 of that file; `writeManifest` writes
 * `manifest.json` as given.
 */
export function useServedProgramDir(): {
  writeProgram: (params: { file: string; content: string }) => Promise<string>;
  writeManifest: (content: string) => Promise<void>;
} {
  let downloadDir: string;
  beforeEach(async () => {
    downloadDir = await mkdtemp(path.join(tmpdir(), "archestra-cli-"));
    config.archestraCli.downloadDir = downloadDir;
  });
  afterEach(async () => {
    await rm(downloadDir, { recursive: true, force: true });
  });
  return {
    writeProgram: async ({ file, content }) => {
      await writeFile(path.join(downloadDir, file), content);
      return sha256Of(content);
    },
    writeManifest: (content) =>
      writeFile(path.join(downloadDir, "manifest.json"), content),
  };
}

/** The SHA-256 of a text in lower-case hex, as the tunnel client reports it. */
export function sha256Of(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Waits for the first poll of a device: from then on it is online. */
export async function waitUntilOnline(deviceId: string): Promise<void> {
  await vi.waitFor(async () => {
    const device = await DesktopDeviceModel.findById(deviceId);
    expect(device?.lastPolledAt).not.toBeNull();
  });
}

/** The `X-Tunnel-MCP-Server-Info` header value for a set of ready channels. */
export function serverInfoHeader(channels: string[]): string {
  return JSON.stringify({
    version: 1,
    channels: channels.map((name) => ({ name, proc_affinity: true })),
  });
}

type McpAnswer = (message: {
  channel: string;
  method: string;
  params?: unknown;
}) => unknown | Promise<unknown>;

/**
 * A stand-in for the tunnel client on a device: it polls the tunnel routes of
 * the given app and answers every request with the given function, over the
 * same HTTP calls the real client makes. An error the function throws becomes
 * a JSON-RPC error. Call `stop()` when done.
 */
export function runTestTunnelClient(params: {
  app: FastifyInstanceWithZod;
  device: TestDevice;
  readyChannels: string[];
  answer: McpAnswer;
}): { stop: () => Promise<void> } {
  const { app, device } = params;
  let stopped = false;

  const loop = (async () => {
    while (!stopped) {
      const poll = await app.inject({
        method: "GET",
        url: `/v1/tunnels/${device.tunnelId}/poll?timeout_ms=200`,
        headers: {
          ...device.headers,
          "x-tunnel-mcp-server-info": serverInfoHeader(params.readyChannels),
        },
      });
      if (poll.statusCode !== 200) continue;
      const { commands } = poll.json<{
        commands: Array<{
          request_id: string;
          channel: string;
          jsonrpc: DesktopMcpJsonRpcMessage;
        }>;
      }>();
      for (const command of commands) {
        const {
          id,
          method,
          params: rpcParams,
        } = command.jsonrpc as {
          id?: string | number;
          method: string;
          params?: unknown;
        };
        const isNotification = id === undefined;
        const payload = isNotification
          ? { resp_type: "notify_ack", resp_code: 202 }
          : {
              resp_type: "jsonrpc_response",
              resp_code: 200,
              resp_json: {
                jsonrpc: "2.0",
                id,
                ...(await answerOf(params.answer, {
                  channel: command.channel,
                  method,
                  params: rpcParams,
                })),
              },
            };
        await app.inject({
          method: "POST",
          url: `/v1/tunnels/${device.tunnelId}/response`,
          headers: device.headers,
          payload: {
            request_id: command.request_id,
            channel: command.channel,
            ...payload,
          },
        });
      }
    }
  })();

  return {
    stop: async () => {
      stopped = true;
      await loop;
    },
  };
}

/** The `result` of an answer, or the JSON-RPC `error` for what it threw. */
async function answerOf(
  answer: McpAnswer,
  message: Parameters<McpAnswer>[0],
): Promise<{ result: unknown } | { error: { code: number; message: string } }> {
  try {
    return { result: await answer(message) };
  } catch (error) {
    return {
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
