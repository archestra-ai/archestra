import { randomUUID } from "node:crypto";
import config from "@/config";
import DesktopDeviceModel from "@/models/desktop-device";
import DesktopMcpRequestModel from "@/models/desktop-mcp-request";
import { desktopTunnelService } from "@/services/desktop-mcp/desktop-tunnel";
import { describe, expect, test } from "@/test";
import { overrideConfig } from "@/test/config";
import {
  connectTestDevice,
  serverInfoHeader,
  sha256Of,
} from "@/test/desktop-mcp";
import { useRouteTestApp } from "@/test/route-test-app";
import desktopTunnelRoutes from "./desktop-tunnel.routes";

describe("GET /v1/tunnels/:tunnelId/poll", () => {
  // An empty poll ends quickly, so the tests do not wait for the real hold.
  overrideConfig({ mcpBridge: { pollMaxWaitMs: 300 } });
  const ctx = useRouteTestApp(desktopTunnelRoutes);

  const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };

  function connect() {
    return connectTestDevice({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
    });
  }

  test("rejects a poll with no device key, a wrong key, or another device's key", async ({
    makeUser,
  }) => {
    const { tunnelId, headers } = await connect();
    const other = await connectTestDevice({
      organizationId: ctx.organizationId,
      userId: (await makeUser()).id,
    });
    const url = `/v1/tunnels/${tunnelId}/poll?timeout_ms=0`;

    const noKey = await ctx.app.inject({ method: "GET", url });
    const wrongKey = await ctx.app.inject({
      method: "GET",
      url,
      headers: { authorization: "Bearer archestra_dev_not-a-real-key" },
    });
    const otherDevicesKey = await ctx.app.inject({
      method: "GET",
      url,
      headers: other.headers,
    });
    const ownKey = await ctx.app.inject({ method: "GET", url, headers });

    expect(noKey.statusCode).toBe(401);
    expect(wrongKey.statusCode).toBe(401);
    expect(otherDevicesKey.statusCode).toBe(403);
    expect(ownKey.statusCode).toBe(204);
  });

  test("answers 204 on an empty queue and records that the device is alive", async () => {
    const { device, tunnelId, headers } = await connect();
    const channel = randomUUID();
    expect(desktopTunnelService.isOnline(device)).toBe(false);

    const response = await ctx.app.inject({
      method: "GET",
      url: `/v1/tunnels/${tunnelId}/poll?timeout_ms=0`,
      headers: {
        ...headers,
        "x-tunnel-mcp-server-info": serverInfoHeader([channel]),
      },
    });

    expect(response.statusCode).toBe(204);
    const polled = await DesktopDeviceModel.findById(device.id);
    expect(polled && desktopTunnelService.isOnline(polled)).toBe(true);
  });

  test("a malformed server-info header does not fail the poll", async () => {
    const { device, tunnelId, headers } = await connect();

    const response = await ctx.app.inject({
      method: "GET",
      url: `/v1/tunnels/${tunnelId}/poll?timeout_ms=0`,
      headers: { ...headers, "x-tunnel-mcp-server-info": "{not json" },
    });

    expect(response.statusCode).toBe(204);
    const polled = await DesktopDeviceModel.findById(device.id);
    expect(polled && desktopTunnelService.isOnline(polled)).toBe(true);
  });

  test("stores the version, the target and the SHA-256 of the program the tunnel client reports", async () => {
    const { device, tunnelId, headers } = await connect();
    const sha256 = sha256Of("the program that runs");

    const response = await ctx.app.inject({
      method: "GET",
      url: `/v1/tunnels/${tunnelId}/poll?timeout_ms=0`,
      headers: {
        ...headers,
        "x-tunnel-client-version": "0.1.0",
        // As `uname` prints it: stored in the spelling of the files.
        "x-tunnel-client-target": "Darwin-aarch64",
        "x-tunnel-client-sha256": sha256,
      },
    });

    expect(response.statusCode).toBe(204);
    expect(await DesktopDeviceModel.findById(device.id)).toMatchObject({
      clientVersion: "0.1.0",
      clientTarget: "darwin-arm64",
      clientSha256: sha256,
    });
  });

  test("stores a program that changed at once, and nothing for a poll that follows with the same program", async () => {
    const { device, tunnelId, headers } = await connect();
    const url = `/v1/tunnels/${tunnelId}/poll?timeout_ms=0`;
    const before = {
      ...headers,
      "x-tunnel-client-version": "0.1.0",
      "x-tunnel-client-target": "linux-x86_64",
      "x-tunnel-client-sha256": sha256Of("version one"),
    };
    const after = {
      ...before,
      "x-tunnel-client-version": "0.2.0",
      "x-tunnel-client-sha256": sha256Of("version two"),
    };

    await ctx.app.inject({ method: "GET", url, headers: before });
    const first = await DesktopDeviceModel.findById(device.id);
    // The program updated itself: its next poll comes within the 10 s in
    // which a poll is not stored.
    await ctx.app.inject({ method: "GET", url, headers: after });
    const updated = await DesktopDeviceModel.findById(device.id);
    await ctx.app.inject({ method: "GET", url, headers: after });
    const unchanged = await DesktopDeviceModel.findById(device.id);

    expect(first).toMatchObject({
      clientVersion: "0.1.0",
      clientSha256: sha256Of("version one"),
    });
    expect(updated).toMatchObject({
      clientVersion: "0.2.0",
      clientTarget: "linux-x86_64",
      clientSha256: sha256Of("version two"),
    });
    expect(unchanged?.updatedAt).toEqual(updated?.updatedAt);
  });

  test("values that are not valid are stored as null and do not fail the poll", async () => {
    const { device, tunnelId, headers } = await connect();
    const url = `/v1/tunnels/${tunnelId}/poll?timeout_ms=0`;
    await ctx.app.inject({
      method: "GET",
      url,
      headers: {
        ...headers,
        "x-tunnel-client-version": "0.1.0",
        "x-tunnel-client-target": "darwin-arm64",
        "x-tunnel-client-sha256": sha256Of("the program that runs"),
      },
    });

    const response = await ctx.app.inject({
      method: "GET",
      url,
      headers: {
        ...headers,
        "x-tunnel-client-version": "v".repeat(33),
        "x-tunnel-client-target": "darwin-ppc",
        // Upper case is not the form the served file's SHA-256 has.
        "x-tunnel-client-sha256": sha256Of("x").toUpperCase(),
      },
    });

    expect(response.statusCode).toBe(204);
    expect(await DesktopDeviceModel.findById(device.id)).toMatchObject({
      clientVersion: null,
      clientTarget: null,
      clientSha256: null,
    });
  });

  test("a tunnel client that reports no program has none stored", async () => {
    const { device, tunnelId, headers } = await connect();

    const response = await ctx.app.inject({
      method: "GET",
      url: `/v1/tunnels/${tunnelId}/poll?timeout_ms=0`,
      headers,
    });

    expect(response.statusCode).toBe(204);
    expect(await DesktopDeviceModel.findById(device.id)).toMatchObject({
      clientVersion: null,
      clientTarget: null,
      clientSha256: null,
    });
  });

  test("returns a waiting MCP message once, in the tunnel protocol's shape", async () => {
    const { device, tunnelId, headers } = await connect();
    const channel = randomUUID();
    const requestId = await desktopTunnelService.enqueue({
      deviceId: device.id,
      channel,
      message: listTools,
    });
    const url = `/v1/tunnels/${tunnelId}/poll?timeout_ms=0`;

    const first = await ctx.app.inject({ method: "GET", url, headers });
    const second = await ctx.app.inject({ method: "GET", url, headers });

    expect(first.statusCode).toBe(200);
    const [command] = first.json().commands;
    expect(command).toMatchObject({
      request_id: requestId,
      command_type: "jsonrpc",
      channel,
      headers: {},
      jsonrpc: listTools,
    });
    expect(command.response_timeout).toMatch(/^\d+ms$/);
    expect(command).not.toHaveProperty("shard_token");
    expect(second.statusCode).toBe(204);
  });

  test("a held poll returns as soon as a message is queued", async () => {
    config.mcpBridge.pollMaxWaitMs = 10_000;
    const { device, tunnelId, headers } = await connect();

    const startedAt = Date.now();
    const poll = ctx.app.inject({
      method: "GET",
      url: `/v1/tunnels/${tunnelId}/poll?timeout_ms=10000`,
      headers,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await desktopTunnelService.enqueue({
      deviceId: device.id,
      channel: randomUUID(),
      message: listTools,
    });
    const response = await poll;

    expect(response.statusCode).toBe(200);
    expect(response.json().commands).toHaveLength(1);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  test("two polls at the same time do not both get the same message", async () => {
    const { device, tunnelId, headers } = await connect();
    await desktopTunnelService.enqueue({
      deviceId: device.id,
      channel: randomUUID(),
      message: listTools,
    });
    const url = `/v1/tunnels/${tunnelId}/poll?timeout_ms=0`;

    const responses = await Promise.all([
      ctx.app.inject({ method: "GET", url, headers }),
      ctx.app.inject({ method: "GET", url, headers }),
    ]);

    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 204]);
  });

  test("does not hand out a message whose caller stopped waiting", async () => {
    const { device, tunnelId, headers } = await connect();
    await DesktopMcpRequestModel.create({
      deviceId: device.id,
      channel: randomUUID(),
      payload: listTools,
      expiresAt: new Date(Date.now() - 1_000),
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/v1/tunnels/${tunnelId}/poll?timeout_ms=0`,
      headers,
    });

    expect(response.statusCode).toBe(204);
  });
});
