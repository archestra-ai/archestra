import { randomUUID } from "node:crypto";
import DesktopDeviceModel from "@/models/desktop-device";
import DesktopMcpRequestModel from "@/models/desktop-mcp-request";
import { describe, expect, test } from "@/test";
import { connectTestDevice } from "@/test/desktop-mcp";
import { desktopTunnelService } from "./desktop-tunnel";

describe("desktopTunnelService", () => {
  const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };
  const neverAborted = new AbortController().signal;

  test("a caller stops waiting when the deadline of its request has passed", async ({
    makeOrganization,
    makeUser,
  }) => {
    const { device } = await connectTestDevice({
      organizationId: (await makeOrganization()).id,
      userId: (await makeUser()).id,
    });
    const request = await DesktopMcpRequestModel.create({
      deviceId: device.id,
      channel: randomUUID(),
      payload: listTools,
      expiresAt: new Date(Date.now() - 1),
    });

    const response = await desktopTunnelService.awaitResponse({
      requestId: request.id,
      signal: neverAborted,
    });

    expect(response).toBeNull();
    expect(await DesktopMcpRequestModel.findById(request.id)).toBeNull();
  });

  test("a caller stops waiting when its device is replaced by a new sign-in", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const userId = (await makeUser()).id;
    const first = await connectTestDevice({ organizationId, userId });
    const requestId = await desktopTunnelService.enqueue({
      deviceId: first.device.id,
      channel: randomUUID(),
      message: listTools,
    });
    const waiting = desktopTunnelService.awaitResponse({
      requestId,
      signal: neverAborted,
    });

    const second = await connectTestDevice({
      organizationId,
      userId,
      name: "New laptop",
    });

    expect(await waiting).toBeNull();
    // One device per user: the first is gone and its key no longer works.
    expect(await DesktopDeviceModel.findById(first.device.id)).toBeNull();
    await expect(
      desktopTunnelService.authenticate({
        tunnelId: first.tunnelId,
        deviceKey: first.deviceKey,
      }),
    ).rejects.toMatchObject({ statusCode: 401 });
    await expect(
      desktopTunnelService.authenticate({
        tunnelId: second.tunnelId,
        deviceKey: second.deviceKey,
      }),
    ).resolves.toMatchObject({ id: second.device.id });
  });

  test("a device is online only while its last poll is recent", () => {
    const now = Date.now();

    expect(desktopTunnelService.isOnline({ lastPolledAt: null })).toBe(false);
    expect(
      desktopTunnelService.isOnline({ lastPolledAt: new Date(now - 1_000) }),
    ).toBe(true);
    expect(
      desktopTunnelService.isOnline({
        // Offline after 35 seconds with no poll.
        lastPolledAt: new Date(now - 36_000),
      }),
    ).toBe(false);
  });
});
