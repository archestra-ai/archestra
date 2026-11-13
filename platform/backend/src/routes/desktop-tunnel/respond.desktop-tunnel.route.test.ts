import { randomUUID } from "node:crypto";
import DesktopDeviceServerModel from "@/models/desktop-device-server";
import DesktopMcpRequestModel from "@/models/desktop-mcp-request";
import { DESKTOP_BRIDGE_CHANNEL } from "@/services/desktop-mcp/desktop-bridge-control";
import { desktopTunnelService } from "@/services/desktop-mcp/desktop-tunnel";
import { describe, expect, test } from "@/test";
import { connectTestDevice, type TestDevice } from "@/test/desktop-mcp";
import { useRouteTestApp } from "@/test/route-test-app";
import desktopTunnelRoutes from "./desktop-tunnel.routes";

describe("POST /v1/tunnels/:tunnelId/response", () => {
  const ctx = useRouteTestApp(desktopTunnelRoutes);

  const toolsResult = { jsonrpc: "2.0", id: 1, result: { tools: [] } };

  function connect() {
    return connectTestDevice({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
    });
  }

  /** Queues a message and takes it with a poll, as the tunnel client does. */
  async function dispatch(device: TestDevice, message: object) {
    const requestId = await desktopTunnelService.enqueue({
      deviceId: device.device.id,
      channel: randomUUID(),
      message: message as Record<string, unknown>,
    });
    await ctx.app.inject({
      method: "GET",
      url: `/v1/tunnels/${device.tunnelId}/poll?timeout_ms=0`,
      headers: device.headers,
    });
    return requestId;
  }

  function respond(device: TestDevice, payload: object) {
    return ctx.app.inject({
      method: "POST",
      url: `/v1/tunnels/${device.tunnelId}/response`,
      headers: device.headers,
      payload,
    });
  }

  test("delivers the MCP response to the caller that waits for it", async () => {
    const device = await connect();
    const requestId = await dispatch(device, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const waiting = desktopTunnelService.awaitResponse({
      requestId,
      signal: new AbortController().signal,
    });

    const response = await respond(device, {
      request_id: requestId,
      resp_json: toolsResult,
      resp_headers: { "Content-Type": ["application/json"] },
      resp_code: 200,
      resp_type: "jsonrpc_response",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(await waiting).toEqual(toolsResult);
    // The queue row is gone once its caller has the response.
    expect(await DesktopMcpRequestModel.findById(requestId)).toBeNull();
  });

  test("answers 404 for a request that is not waiting for a response", async ({
    makeUser,
  }) => {
    const device = await connect();
    const other = await connectTestDevice({
      organizationId: ctx.organizationId,
      userId: (await makeUser()).id,
    });
    const ofOtherDevice = await dispatch(other, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const answered = await dispatch(device, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const body = { resp_json: toolsResult, resp_code: 200 };
    await respond(device, { request_id: answered, ...body });
    // Queued after the last poll, so no poll has taken it.
    const notPolledYet = await desktopTunnelService.enqueue({
      deviceId: device.device.id,
      channel: randomUUID(),
      message: { jsonrpc: "2.0", id: 3, method: "tools/list" },
    });

    const statuses = await Promise.all(
      [randomUUID(), notPolledYet, ofOtherDevice, answered].map(
        async (request_id) =>
          (await respond(device, { request_id, ...body })).statusCode,
      ),
    );

    expect(statuses).toEqual([404, 404, 404, 404]);
  });

  test("an acknowledged notification leaves nothing in the queue", async () => {
    const device = await connect();
    const requestId = await dispatch(device, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    const response = await respond(device, {
      request_id: requestId,
      resp_code: 202,
      resp_type: "notify_ack",
    });

    expect(response.statusCode).toBe(200);
    expect(await DesktopMcpRequestModel.findById(requestId)).toBeNull();
  });

  test("a progress notification is accepted and does not end the request", async () => {
    const device = await connect();
    const requestId = await dispatch(device, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
    });

    const response = await respond(device, {
      request_id: requestId,
      resp_json: { jsonrpc: "2.0", method: "notifications/progress" },
      resp_code: 200,
      resp_type: "jsonrpc_notify",
    });

    expect(response.statusCode).toBe(200);
    const request = await DesktopMcpRequestModel.findById(requestId);
    expect(request?.status).toBe("dispatched");
  });

  test("rejects a final response with no MCP message and a request with a wrong key", async () => {
    const device = await connect();
    const requestId = await dispatch(device, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });

    const noMessage = await respond(device, {
      request_id: requestId,
      resp_code: 200,
      resp_type: "jsonrpc_response",
    });
    const wrongKey = await ctx.app.inject({
      method: "POST",
      url: `/v1/tunnels/${device.tunnelId}/response`,
      headers: { authorization: "Bearer archestra_dev_not-a-real-key" },
      payload: {
        request_id: requestId,
        resp_json: toolsResult,
        resp_code: 200,
      },
    });

    expect(noMessage.statusCode).toBe(400);
    expect(wrongKey.statusCode).toBe(401);
    // Neither attempt consumed the request.
    const request = await DesktopMcpRequestModel.findById(requestId);
    expect(request?.status).toBe("dispatched");
  });

  describe("state report of the tunnel client", () => {
    function report(device: TestDevice, params: object, channel?: string) {
      return respond(device, {
        request_id: randomUUID(),
        channel: channel ?? DESKTOP_BRIDGE_CHANNEL,
        resp_code: 200,
        resp_type: "jsonrpc_notify",
        resp_json: { jsonrpc: "2.0", method: "bridge/state", params },
      });
    }

    test("stores the state of each MCP server", async ({
      makeInternalMcpCatalog,
    }) => {
      const device = await connect();
      const running = await makeInternalMcpCatalog({
        organizationId: ctx.organizationId,
        serverType: "desktop_mcp",
      });
      const failed = await makeInternalMcpCatalog({
        organizationId: ctx.organizationId,
        serverType: "desktop_mcp",
      });

      const response = await report(device, {
        servers: [
          { channel: running.id, state: "running", error: null },
          { channel: failed.id, state: "failed", error: "file not found" },
          // A catalog item that does not exist any more is dropped.
          { channel: randomUUID(), state: "running", error: null },
        ],
        // An older tunnel client also reports its macOS permissions: the
        // key is ignored.
        permissions: { screen_recording: true, accessibility: false },
      });

      expect(response.statusCode).toBe(200);
      const rows = await DesktopDeviceServerModel.findByDeviceId(
        device.device.id,
      );
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            catalogId: running.id,
            state: "running",
            lastError: null,
          }),
          expect.objectContaining({
            catalogId: failed.id,
            state: "failed",
            lastError: "file not found",
          }),
        ]),
      );
    });

    test("a later report replaces the state and keeps Stop", async ({
      makeInternalMcpCatalog,
    }) => {
      const device = await connect();
      const item = await makeInternalMcpCatalog({
        organizationId: ctx.organizationId,
        serverType: "desktop_mcp",
      });
      await DesktopDeviceServerModel.saveEnabled({
        deviceId: device.device.id,
        catalogId: item.id,
        enabled: false,
      });
      await report(device, {
        servers: [{ channel: item.id, state: "failed", error: "exit 1" }],
      });

      await report(device, {
        servers: [{ channel: item.id, state: "running", error: null }],
      });

      expect(
        await DesktopDeviceServerModel.findByDeviceId(device.device.id),
      ).toEqual([
        expect.objectContaining({
          state: "running",
          lastError: null,
          enabled: false,
        }),
      ]);
    });

    test("drops a report that is not valid or is not on the reserved channel", async ({
      makeInternalMcpCatalog,
    }) => {
      const device = await connect();
      const item = await makeInternalMcpCatalog({
        organizationId: ctx.organizationId,
        serverType: "desktop_mcp",
      });
      const servers = [{ channel: item.id, state: "running", error: null }];

      const unknownState = await report(device, {
        servers: [{ channel: item.id, state: "exploded" }],
      });
      const otherChannel = await report(device, { servers }, item.id);

      expect(unknownState.statusCode).toBe(200);
      expect(otherChannel.statusCode).toBe(200);
      expect(
        await DesktopDeviceServerModel.findByDeviceId(device.device.id),
      ).toEqual([]);
    });
  });
});
