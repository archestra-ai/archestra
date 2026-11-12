import { vi } from "vitest";
import { auth as betterAuth } from "@/auth/better-auth";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import DesktopDeviceModel from "@/models/desktop-device";
import DesktopMcpRequestModel from "@/models/desktop-mcp-request";
import { DESKTOP_BRIDGE_CHANNEL } from "@/services/desktop-mcp/desktop-bridge-control";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { connectTestDevice } from "@/test/desktop-mcp";
import type { DesktopMcpConfig, User } from "@/types";

/**
 * A desktop MCP catalog item tells each device how to start its MCP server.
 * A change of such an item makes the tunnel clients get their config again.
 */
describe("/api/internal_mcp_catalog — command for devices", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  const betaAtStart = config.beta;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    // Desktop MCP is in alpha, behind the beta flag.
    config.beta = true;
    vi.spyOn(betterAuth.api, "getSession").mockImplementation(
      async () => ({ user: { id: user.id } }) as never,
    );

    user = await makeUser();
    organizationId = (await makeOrganization()).id;
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: routes } = await import("./internal-mcp-catalog");
    await app.register(routes);
  });

  afterEach(async () => {
    config.beta = betaAtStart;
    vi.restoreAllMocks();
    await app.close();
  });

  function create(payload: object) {
    return app.inject({
      method: "POST",
      url: "/api/internal_mcp_catalog",
      payload,
    });
  }

  function update(id: string, payload: object) {
    return app.inject({
      method: "PUT",
      url: `/api/internal_mcp_catalog/${id}`,
      payload,
    });
  }

  /** The `bridge/sync` messages that wait for a device, taken from its queue. */
  async function takeSyncMessages(deviceId: string) {
    const queued = await DesktopMcpRequestModel.claimPending({
      deviceId,
      limit: 25,
    });
    return queued.filter(
      (request) =>
        request.channel === DESKTOP_BRIDGE_CHANNEL &&
        request.payload.method === "bridge/sync",
    );
  }

  test("stores the command or the URL of a desktop MCP catalog item", async () => {
    const created = await create({
      name: "screen-mcp",
      serverType: "desktop_mcp",
      desktopConfig: { command: "  /Users/$USER/bins/screen-mcp serve  " },
    });

    expect(created.statusCode).toBe(200);
    expect(created.json().desktopConfig).toEqual({
      command: "/Users/$USER/bins/screen-mcp serve",
    });

    // An older form also sends the macOS permissions: they are dropped.
    const updated = await update(created.json().id, {
      desktopConfig: {
        url: "http://127.0.0.1:8080/mcp",
        permissions: ["accessibility"],
      },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json().desktopConfig).toEqual({
      url: "http://127.0.0.1:8080/mcp",
    });
  });

  test("reads an item that an older version stored with its permissions", async ({
    makeInternalMcpCatalog,
  }) => {
    const stored = await makeInternalMcpCatalog({
      organizationId,
      name: "screen-mcp",
      serverType: "desktop_mcp",
      desktopConfig: {
        command: "/opt/screen-mcp",
        permissions: ["screen_recording"],
      } as DesktopMcpConfig,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/internal_mcp_catalog/${stored.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().desktopConfig).toEqual({
      command: "/opt/screen-mcp",
    });
  });

  test("rejects a command together with a URL, and a command on a server of another type", async () => {
    const both = await create({
      name: "both",
      serverType: "desktop_mcp",
      desktopConfig: {
        command: "/opt/mcp",
        url: "http://127.0.0.1:8080/mcp",
      },
    });
    const remote = await create({
      name: "remote",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
      desktopConfig: { command: "/opt/mcp" },
    });
    const existingRemote = await create({
      name: "existing-remote",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
    });
    // A partial update that does not name the server type.
    const remoteUpdate = await update(existingRemote.json().id, {
      desktopConfig: { command: "/opt/mcp" },
    });

    expect(existingRemote.statusCode).toBe(200);
    expect(
      [both, remote, remoteUpdate].map((response) => response.statusCode),
    ).toEqual([400, 400, 400]);
  });

  test("creating, changing and deleting a desktop MCP catalog item tells every online device of the organization to sync", async ({
    makeUser,
    makeMember,
    makeOrganization,
  }) => {
    const colleague = await makeUser();
    await makeMember(colleague.id, organizationId);
    const own = await connectTestDevice({ organizationId, userId: user.id });
    const ofColleague = await connectTestDevice({
      organizationId,
      userId: colleague.id,
    });
    const otherOrganization = await connectTestDevice({
      organizationId: (await makeOrganization()).id,
      userId: (await makeUser()).id,
    });
    // A device that never polled is offline: it syncs when it starts, so no
    // message waits for it.
    const offlineUser = await makeUser();
    await makeMember(offlineUser.id, organizationId);
    const offline = await connectTestDevice({
      organizationId,
      userId: offlineUser.id,
    });
    for (const online of [own, ofColleague, otherOrganization]) {
      await DesktopDeviceModel.recordPoll(online.device.id);
    }

    const created = await create({
      name: "MATLAB",
      serverType: "desktop_mcp",
      desktopConfig: { command: "/opt/matlab/mcp" },
    });
    const afterCreate = [
      await takeSyncMessages(own.device.id),
      await takeSyncMessages(ofColleague.device.id),
      await takeSyncMessages(otherOrganization.device.id),
      await takeSyncMessages(offline.device.id),
    ].map((messages) => messages.length);

    await update(created.json().id, {
      desktopConfig: { command: "/opt/matlab/mcp --stdio" },
    });
    const afterUpdate = (await takeSyncMessages(own.device.id)).length;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/internal_mcp_catalog/${created.json().id}`,
    });
    const afterDelete = (await takeSyncMessages(own.device.id)).length;

    expect(created.statusCode).toBe(200);
    expect(deleted.statusCode).toBe(200);
    expect(afterCreate).toEqual([1, 1, 0, 0]);
    expect(afterUpdate).toBe(1);
    expect(afterDelete).toBe(1);
  });

  test("a catalog item of another type does not make devices sync", async () => {
    const own = await connectTestDevice({ organizationId, userId: user.id });

    const created = await create({
      name: "remote",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
    });

    expect(created.statusCode).toBe(200);
    expect(await takeSyncMessages(own.device.id)).toEqual([]);
  });

  test("without the beta flag, a server cannot become a desktop MCP server, and one that is keeps working", async () => {
    const remote = await create({
      name: "remote",
      serverType: "remote",
      serverUrl: "https://mcp.example.com/mcp",
    });
    const desktop = await create({
      name: "matlab",
      serverType: "desktop_mcp",
      desktopConfig: { command: "/opt/matlab-mcp" },
    });
    expect(remote.statusCode).toBe(200);
    expect(desktop.statusCode).toBe(200);

    config.beta = false;

    const switched = await update(remote.json().id, {
      serverType: "desktop_mcp",
    });
    const edited = await update(desktop.json().id, {
      desktopConfig: { command: "/opt/matlab-mcp serve" },
    });

    expect(switched.statusCode).toBe(403);
    expect(edited.statusCode).toBe(200);
  });
});
