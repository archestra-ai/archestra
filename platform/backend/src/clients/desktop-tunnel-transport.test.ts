import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import DesktopDeviceModel from "@/models/desktop-device";
import DesktopDeviceServerModel from "@/models/desktop-device-server";
import desktopTunnelRoutes from "@/routes/desktop-tunnel/desktop-tunnel.routes";
import { describe, expect, test } from "@/test";
import {
  connectTestDevice,
  runTestTunnelClient,
  type TestDevice,
} from "@/test/desktop-mcp";
import { useRouteTestApp } from "@/test/route-test-app";
import { DesktopTunnelTransport } from "./desktop-tunnel-transport";

describe("DesktopTunnelTransport", () => {
  const ctx = useRouteTestApp(desktopTunnelRoutes);
  const channel = randomUUID();

  function connect() {
    return connectTestDevice({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      name: "MBP-0142",
    });
  }

  function transportTo(device: TestDevice) {
    return new DesktopTunnelTransport({
      userId: device.device.userId,
      channel,
      serverName: "Notes",
    });
  }

  /** Answers as a small MCP server with one tool would. */
  function answerAsNotesServer(message: { method: string; params?: unknown }) {
    switch (message.method) {
      case "initialize":
        return {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "notes", version: "1.0.0" },
        };
      case "tools/list":
        return {
          tools: [
            {
              name: "read_file",
              description: "Reads a file",
              inputSchema: { type: "object", properties: {} },
            },
          ],
        };
      case "tools/call":
        return {
          content: [
            { type: "text", text: `called ${JSON.stringify(message.params)}` },
          ],
        };
      default:
        return {};
    }
  }

  test("an MCP client reaches the server on the device through the queue", async () => {
    const device = await connect();
    const tunnelClient = runTestTunnelClient({
      app: ctx.app,
      device,
      readyChannels: [channel],
      answer: answerAsNotesServer,
    });
    // The device is online once its tunnel client has polled.
    await expect
      .poll(
        async () =>
          (await DesktopDeviceModel.findById(device.device.id))?.lastPolledAt,
      )
      .not.toBeNull();
    const client = new Client({ name: "test", version: "1.0.0" });

    try {
      await client.connect(transportTo(device));
      const { tools } = await client.listTools();
      const result = await client.callTool({
        name: "read_file",
        arguments: { path: "notes.txt" },
      });

      expect(client.getServerVersion()).toEqual({
        name: "notes",
        version: "1.0.0",
      });
      expect(tools.map((tool) => tool.name)).toEqual(["read_file"]);
      expect(result.content).toEqual([
        {
          type: "text",
          text: 'called {"name":"read_file","arguments":{"path":"notes.txt"}}',
        },
      ]);
    } finally {
      await client.close();
      await tunnelClient.stop();
    }
  });

  test("a transport made before a new sign-in reaches the new device", async () => {
    const old = await connect();
    const client = new Client({ name: "test", version: "1.0.0" });
    const transport = transportTo(old);
    // The same user signs in again: the old device is replaced.
    const device = await connect();
    const tunnelClient = runTestTunnelClient({
      app: ctx.app,
      device,
      readyChannels: [channel],
      answer: answerAsNotesServer,
    });
    await expect
      .poll(
        async () =>
          (await DesktopDeviceModel.findById(device.device.id))?.lastPolledAt,
      )
      .not.toBeNull();

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();

      expect(tools.map((tool) => tool.name)).toEqual(["read_file"]);
    } finally {
      await client.close();
      await tunnelClient.stop();
    }
  });

  test("a call to a device that does not poll fails at once and names the device", async () => {
    const device = await connect();
    const client = new Client({ name: "test", version: "1.0.0" });
    const startedAt = Date.now();

    await expect(client.connect(transportTo(device))).rejects.toThrow(
      'Device "MBP-0142" is offline',
    );

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await client.close();
  });

  test("a call to a server the user stopped says so at once and does not go to the device", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalogItem = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "Notes",
      serverType: "desktop_mcp",
      desktopConfig: { command: "notes-mcp" },
    });
    const device = await connect();
    const asked: string[] = [];
    const tunnelClient = runTestTunnelClient({
      app: ctx.app,
      device,
      readyChannels: [],
      answer: (message) => {
        asked.push(message.method);
        return {};
      },
    });
    await expect
      .poll(
        async () =>
          (await DesktopDeviceModel.findById(device.device.id))?.lastPolledAt,
      )
      .not.toBeNull();
    const connectToNotes = () =>
      new Client({ name: "test", version: "1.0.0" }).connect(
        new DesktopTunnelTransport({
          userId: device.device.userId,
          channel: catalogItem.id,
          serverName: "Notes",
        }),
      );
    try {
      await DesktopDeviceServerModel.saveEnabled({
        deviceId: device.device.id,
        catalogId: catalogItem.id,
        enabled: false,
      });
      await expect(connectToNotes()).rejects.toThrow(
        'Notes is stopped on "MBP-0142". Start it on the Devices tab',
      );
      expect(asked).toEqual([]);
    } finally {
      await tunnelClient.stop();
    }
  });
});
