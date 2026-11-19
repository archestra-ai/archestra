import config from "@/config";
import DesktopDeviceServerModel from "@/models/desktop-device-server";
import { describe, expect, type TestFixtures, test } from "@/test";
import { connectTestDevice, useServedProgramDir } from "@/test/desktop-mcp";
import { useRouteTestApp } from "@/test/route-test-app";
import type { DesktopMcpConfig } from "@/types";
import desktopTunnelRoutes from "./desktop-tunnel.routes";

describe("GET /v1/tunnels/:tunnelId", () => {
  const ctx = useRouteTestApp(desktopTunnelRoutes);
  const served = useServedProgramDir();

  /** The `program` of the sync answer for the given request headers. */
  async function syncedProgram(headers: Record<string, string>) {
    const device = await connectTestDevice({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
    });
    const response = await ctx.app.inject({
      method: "GET",
      url: `/v1/tunnels/${device.tunnelId}`,
      headers: { ...device.headers, ...headers },
    });
    expect(response.statusCode).toBe(200);
    return response.json().program;
  }

  test("returns the tunnel with the desktop MCP catalog items the user installed and can use", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
    makeUser,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const matlab = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "MATLAB",
      serverType: "desktop_mcp",
    });
    // Not for a device: a remote server and another organization's item.
    await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "Remote server",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
    });
    await makeInternalMcpCatalog({
      name: "Other organization",
      serverType: "desktop_mcp",
    });
    await installFor(makeMcpServer, matlab.id, ctx.user.id);
    // Installed by another user only, and uninstalled by this user.
    const notInstalled = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "Notes",
      serverType: "desktop_mcp",
    });
    await installFor(makeMcpServer, notInstalled.id, (await makeUser()).id);
    await makeMcpServer({
      catalogId: notInstalled.id,
      serverType: "desktop_mcp",
      scope: "personal",
      ownerId: ctx.user.id,
      deletedAt: new Date(),
    });
    const { tunnelId, headers } = await connectTestDevice({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
      name: "MBP-0142",
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/v1/tunnels/${tunnelId}`,
      headers,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: tunnelId,
      name: "MBP-0142",
      description: "",
      catalog_items: [
        {
          id: matlab.id,
          name: "MATLAB",
          command: null,
          arguments: [],
          url: null,
          enabled: true,
        },
      ],
      // The request named no target.
      program: null,
    });
  });

  test("describes the program served for the target of the request: the version of the manifest and the SHA-256 of the file", async () => {
    const sha256 = await served.writeProgram({
      file: "archestra-darwin-arm64",
      content: "program for Apple silicon",
    });
    await served.writeProgram({
      file: "archestra-linux-x86_64",
      content: "program for Linux x86_64",
    });
    await served.writeManifest(JSON.stringify({ version: "0.2.0" }));

    const program = await syncedProgram({
      "x-tunnel-client-target": "darwin-arm64",
    });

    expect(program).toEqual({ version: "0.2.0", sha256, auto_update: true });
  });

  test("gives the SHA-256 of the file as it is now, after the file is replaced", async () => {
    const first = await served.writeProgram({
      file: "archestra-darwin-arm64",
      content: "version one",
    });
    const before = await syncedProgram({
      "x-tunnel-client-target": "darwin-arm64",
    });
    const second = await served.writeProgram({
      file: "archestra-darwin-arm64",
      content: "version two, a longer file",
    });
    const after = await syncedProgram({
      "x-tunnel-client-target": "darwin-arm64",
    });

    expect(before.sha256).toBe(first);
    expect(after.sha256).toBe(second);
    expect(second).not.toBe(first);
  });

  test("the version is null with no manifest, and with a manifest that is not valid", async () => {
    const sha256 = await served.writeProgram({
      file: "archestra-windows-x86_64.exe",
      content: "program for Windows x64",
    });
    const headers = { "x-tunnel-client-target": "windows-x86_64" };

    const noManifest = await syncedProgram(headers);
    await served.writeManifest("{not json");
    const notJson = await syncedProgram(headers);
    await served.writeManifest(JSON.stringify({ version: 2 }));
    const notAVersion = await syncedProgram(headers);

    const unversioned = { version: null, sha256, auto_update: true };
    expect(noManifest).toEqual(unversioned);
    expect(notJson).toEqual(unversioned);
    expect(notAVersion).toEqual(unversioned);
  });

  test("the program is null for a target that is unknown, missing, or has no file", async () => {
    await served.writeProgram({
      file: "archestra-darwin-arm64",
      content: "program for Apple silicon",
    });
    await served.writeManifest(JSON.stringify({ version: "0.2.0" }));

    const unknownTarget = await syncedProgram({
      "x-tunnel-client-target": "../manifest.json",
    });
    const noHeader = await syncedProgram({});
    const noFile = await syncedProgram({
      "x-tunnel-client-target": "linux-arm64",
    });
    config.archestraCli.downloadDir = "/no/such/folder";
    const noFolder = await syncedProgram({
      "x-tunnel-client-target": "darwin-arm64",
    });

    expect(unknownTarget).toBeNull();
    expect(noHeader).toBeNull();
    expect(noFile).toBeNull();
    expect(noFolder).toBeNull();
  });

  test("says that auto-update is off when the deployment turned it off", async () => {
    config.mcpBridge.autoUpdateEnabled = false;
    await served.writeProgram({
      file: "archestra-linux-arm64",
      content: "program for Linux arm64",
    });

    const program = await syncedProgram({
      // As `uname` prints it: the same target.
      "x-tunnel-client-target": "Linux-aarch64",
    });

    expect(program).toMatchObject({ auto_update: false });
  });

  test("gives the command or the URL of the catalog item, and Stop", async ({
    makeInternalMcpCatalog,
    makeMcpServer,
    makeMember,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId);
    const fromCatalog = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "A from the catalog item",
      serverType: "desktop_mcp",
      // Stored by an older version, with the permissions it had: the key
      // is not passed on.
      desktopConfig: {
        command: "/Users/$USER/bins/screen-mcp serve",
        permissions: ["screen_recording", "accessibility"],
      } as DesktopMcpConfig,
    });
    const stopped = await makeInternalMcpCatalog({
      organizationId: ctx.organizationId,
      name: "C stopped",
      serverType: "desktop_mcp",
      desktopConfig: { url: "http://127.0.0.1:8080/mcp" },
    });
    await installFor(makeMcpServer, fromCatalog.id, ctx.user.id);
    await installFor(makeMcpServer, stopped.id, ctx.user.id);
    const { device, tunnelId, headers } = await connectTestDevice({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
    });
    await DesktopDeviceServerModel.saveEnabled({
      deviceId: device.id,
      catalogId: stopped.id,
      enabled: false,
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/v1/tunnels/${tunnelId}`,
      headers,
    });

    const items = response
      .json<{ catalog_items: Array<{ name: string }> }>()
      .catalog_items.sort((a, b) => a.name.localeCompare(b.name));
    expect(items).toEqual([
      {
        id: fromCatalog.id,
        name: "A from the catalog item",
        command: "/Users/$USER/bins/screen-mcp serve",
        arguments: [],
        url: null,
        enabled: true,
      },
      {
        id: stopped.id,
        name: "C stopped",
        command: null,
        arguments: [],
        url: "http://127.0.0.1:8080/mcp",
        enabled: false,
      },
    ]);
  });

  test("rejects a request with no device key", async () => {
    const { tunnelId } = await connectTestDevice({
      organizationId: ctx.organizationId,
      userId: ctx.user.id,
    });

    const response = await ctx.app.inject({
      method: "GET",
      url: `/v1/tunnels/${tunnelId}`,
    });

    expect(response.statusCode).toBe(401);
  });
});

/** A completed personal installation of a desktop MCP catalog item. */
function installFor(
  makeMcpServer: TestFixtures["makeMcpServer"],
  catalogId: string,
  userId: string,
) {
  return makeMcpServer({
    catalogId,
    serverType: "desktop_mcp",
    scope: "personal",
    ownerId: userId,
    localInstallationStatus: "success",
  });
}
