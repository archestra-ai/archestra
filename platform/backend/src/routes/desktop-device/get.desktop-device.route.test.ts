import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import desktopTunnelRoutes from "@/routes/desktop-tunnel/desktop-tunnel.routes";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  connectTestDevice,
  serverInfoHeader,
  sha256Of,
  useServedProgramDir,
} from "@/test/desktop-mcp";
import type { User } from "@/types";
import { buildDesktopDeviceTestApp } from "./desktop-device.test-helpers";

describe("GET /api/desktop-devices", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  const served = useServedProgramDir();

  /** The user's device as listed, after a poll with the given headers. */
  async function listedAfterPoll(headers: Record<string, string>) {
    const device = await connectTestDevice({ organizationId, userId: user.id });
    await app.inject({
      url: `/v1/tunnels/${device.tunnelId}/poll?timeout_ms=0`,
      headers: { ...device.headers, ...headers },
    });
    const response = await app.inject({ url: "/api/desktop-devices" });
    return response.json()[0];
  }

  beforeEach(async ({ makeUser, makeOrganization, makeMember }) => {
    user = await makeUser();
    organizationId = (await makeOrganization()).id;
    await makeMember(user.id, organizationId);
    app = await buildDesktopDeviceTestApp({ user, organizationId });
    await app.register(desktopTunnelRoutes);
  });
  afterEach(async () => {
    await app.close();
  });

  test("a user with no device gets an empty list", async () => {
    const response = await app.inject({ url: "/api/desktop-devices" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  test("shows the user's device, whether it polls, and one MCP server for each catalog item the user installed", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeUser,
  }) => {
    const matlab = await makeInternalMcpCatalog({
      organizationId,
      name: "MATLAB",
      serverType: "desktop_mcp",
    });
    const eda = await makeInternalMcpCatalog({
      organizationId,
      name: "eda-agent",
      serverType: "desktop_mcp",
    });
    // Not installed by this user: another user installed it, and this user
    // uninstalled it.
    const notInstalled = await makeInternalMcpCatalog({
      organizationId,
      name: "Notes",
      serverType: "desktop_mcp",
    });
    for (const catalogId of [matlab.id, eda.id]) {
      await makeMcpServer({
        catalogId,
        serverType: "desktop_mcp",
        scope: "personal",
        ownerId: user.id,
        localInstallationStatus: "success",
      });
    }
    await makeMcpServer({
      catalogId: notInstalled.id,
      serverType: "desktop_mcp",
      scope: "personal",
      ownerId: (await makeUser()).id,
    });
    await makeMcpServer({
      catalogId: notInstalled.id,
      serverType: "desktop_mcp",
      scope: "personal",
      ownerId: user.id,
      deletedAt: new Date(),
    });
    const device = await connectTestDevice({
      organizationId,
      userId: user.id,
      name: "MBP-0142",
    });
    // Another user's device is not listed.
    await connectTestDevice({
      organizationId,
      userId: (await makeUser()).id,
      name: "Someone else",
    });

    const beforePoll = await app.inject({ url: "/api/desktop-devices" });
    await app.inject({
      url: `/v1/tunnels/${device.tunnelId}/poll?timeout_ms=0`,
      headers: {
        ...device.headers,
        "x-tunnel-mcp-server-info": serverInfoHeader([matlab.id]),
      },
    });
    const afterPoll = await app.inject({ url: "/api/desktop-devices" });

    expect(beforePoll.json()).toMatchObject([
      { name: "MBP-0142", online: false, lastPolledAt: null },
    ]);
    const [listed] = afterPoll.json();
    expect(afterPoll.json()).toHaveLength(1);
    expect(listed).toMatchObject({
      id: device.device.id,
      name: "MBP-0142",
      platform: "macos",
      online: true,
    });
    expect(listed.servers).toHaveLength(2);
    expect(listed.servers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ catalogId: matlab.id, name: "MATLAB" }),
        expect.objectContaining({ catalogId: eda.id, name: "eda-agent" }),
      ]),
    );
  });

  test("shows the version the device reported, and no update while it runs the program Archestra serves", async () => {
    const sha256 = await served.writeProgram({
      file: "archestra-darwin-arm64",
      content: "the served program",
    });
    await served.writeManifest(JSON.stringify({ version: "0.2.0" }));

    const listed = await listedAfterPoll({
      "x-tunnel-client-version": "0.2.0",
      "x-tunnel-client-target": "darwin-arm64",
      "x-tunnel-client-sha256": sha256,
    });

    expect(listed).toMatchObject({
      programVersion: "0.2.0",
      programUpdate: null,
      programAutoUpdate: true,
    });
  });

  test("shows an update, with the served version, when Archestra serves another program for the device's target", async () => {
    await served.writeProgram({
      file: "archestra-darwin-arm64",
      content: "the served program",
    });
    await served.writeManifest(JSON.stringify({ version: "0.2.0" }));
    const reported = {
      "x-tunnel-client-version": "0.1.0",
      "x-tunnel-client-target": "darwin-arm64",
      "x-tunnel-client-sha256": sha256Of("an older program"),
    };

    const withManifest = await listedAfterPoll(reported);
    await served.writeManifest("{not json");
    const withoutVersion = await listedAfterPoll(reported);
    config.mcpBridge.autoUpdateEnabled = false;
    const autoUpdateOff = await listedAfterPoll(reported);

    expect(withManifest).toMatchObject({
      programVersion: "0.1.0",
      programUpdate: { version: "0.2.0" },
      programAutoUpdate: true,
    });
    expect(withoutVersion.programUpdate).toEqual({ version: null });
    expect(autoUpdateOff).toMatchObject({
      programUpdate: { version: null },
      programAutoUpdate: false,
    });
  });

  test("shows no update for a device that reported no program, and for a target with no served file", async () => {
    await served.writeProgram({
      file: "archestra-darwin-arm64",
      content: "the served program",
    });

    const nothingReported = await listedAfterPoll({});
    const noFileForTarget = await listedAfterPoll({
      "x-tunnel-client-version": "0.1.0",
      "x-tunnel-client-target": "linux-x86_64",
      "x-tunnel-client-sha256": sha256Of("an older program"),
    });

    expect(nothingReported).toMatchObject({
      programVersion: null,
      programUpdate: null,
    });
    expect(noFileForTarget).toMatchObject({
      programVersion: "0.1.0",
      programUpdate: null,
    });
  });
});
