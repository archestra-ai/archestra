import { setTimeout as delay } from "node:timers/promises";
import type { DeviceMcpConfig } from "@archestra/shared/device-mcp";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import DeviceMcpModel from "@/models/device-mcp";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import MemberModel from "@/models/member";
import OrganizationModel from "@/models/organization";
import { deviceMcpService } from "@/services/device-mcp";
import { beforeEach, describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import deviceMcpRoutes from "./device-mcp.routes";

const config: DeviceMcpConfig = {
  protocolVersion: 1,
  version: "1.0.0",
  platforms: {
    darwin: { command: "/usr/bin/node", args: ["fixture.mjs"] },
    win32: { command: "C:/runtime/node.exe", args: ["fixture.mjs"] },
  },
  tools: [
    {
      name: "echo",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  ],
};

type Pairing = { code: string; configDigest: string };
type Redeemed = Pairing & { deviceId: string; token: string };
type Session = Redeemed & { sessionId: string };
type Command = {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
};

// A route workflow against real storage. The trusted request context is the
// same boundary used by the repository's route helper; device bearer proofs
// are still validated by the actual endpoint handlers.
describe("device MCP relay workflow", () => {
  const ctx = useRouteTestApp(deviceMcpRoutes);
  let catalogId: string;

  beforeEach(async ({ makeMember, makeInternalMcpCatalog }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    await OrganizationModel.patch(ctx.organizationId, {
      deviceMcpEnabled: true,
    });
    catalogId = (
      await makeInternalMcpCatalog({
        organizationId: ctx.organizationId,
        authorId: ctx.user.id,
        serverType: "device",
        deviceConfig: config,
      })
    ).id;
  });

  async function pair(replaceExisting = false) {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/device-mcp/pair",
      payload: { catalogId, name: "Test workstation", replaceExisting },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const { code, configDigest } = response.json<Pairing>();
    return { code, configDigest };
  }

  async function redeem(pairing: Pairing) {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/device-mcp/redeem",
      payload: { ...pairing, platform: "darwin", protocolVersion: 1 },
    });
    expect(response.statusCode, response.body).toBe(200);
    return {
      ...pairing,
      ...response.json<{ deviceId: string; token: string }>(),
    };
  }

  async function openSession(device: Redeemed) {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/device-mcp/session",
      headers: { authorization: `Bearer ${device.token}` },
      payload: { configDigest: device.configDigest, protocolVersion: 1 },
    });
    expect(response.statusCode, response.body).toBe(200);
    return { ...device, ...response.json<{ sessionId: string }>() };
  }

  async function poll(device: Session, ready = true) {
    return ctx.app.inject({
      method: "POST",
      url: "/api/device-mcp/poll",
      headers: { authorization: `Bearer ${device.token}` },
      payload: { sessionId: device.sessionId, ready },
    });
  }

  async function receive(device: Session) {
    let command: Command | null = null;
    await expect
      .poll(
        async () => {
          const response = await poll(device);
          expect(response.statusCode, response.body).toBe(200);
          command = response.json<{ command: Command | null }>().command;
          return command;
        },
        { timeout: 5000, interval: 25 },
      )
      .not.toBeNull();
    return command as unknown as Command;
  }

  function call(abortSignal?: AbortSignal) {
    // Observe rejections immediately, while the other half of the workflow
    // drives HTTP delivery. No asynchronous work escapes the test.
    return deviceMcpService
      .callTool({
        organizationId: ctx.organizationId,
        userId: ctx.user.id,
        catalogId,
        toolName: "echo",
        arguments: { text: "hello" },
        abortSignal,
      })
      .then(
        (result) => ({ result, error: null }),
        (error: Error) => ({ result: null, error }),
      );
  }

  async function submit(device: Session, commandId: string, text = "hello") {
    return ctx.app.inject({
      method: "POST",
      url: "/api/device-mcp/result",
      headers: { authorization: `Bearer ${device.token}` },
      payload: {
        sessionId: device.sessionId,
        commandId,
        result: { content: [{ type: "text", text }] },
      },
    });
  }

  test("inspects approved config, redeems once, and requires setup before calls", async () => {
    await expect(
      deviceMcpService.callTool({
        organizationId: ctx.organizationId,
        userId: ctx.user.id,
        catalogId,
        toolName: "echo",
        arguments: {},
      }),
    ).rejects.toThrow("Connect your own device");
    const pairing = await pair();
    const inspect = await ctx.app.inject({
      method: "POST",
      url: "/api/device-mcp/inspect",
      payload: { code: pairing.code },
    });
    expect(inspect.statusCode).toBe(200);
    expect(inspect.json().config).toEqual(config);
    const device = await redeem(pairing);
    const repeated = await ctx.app.inject({
      method: "POST",
      url: "/api/device-mcp/redeem",
      payload: { ...pairing, platform: "darwin", protocolVersion: 1 },
    });
    expect(repeated.statusCode).toBe(401);
    await expect(call()).resolves.toMatchObject({
      error: { message: expect.stringContaining("offline") },
    });
    const states = await ctx.app.inject({
      method: "GET",
      url: `/api/device-mcp?catalogId=${catalogId}`,
    });
    expect(states.json()).toEqual([
      expect.objectContaining({ id: device.deviceId, status: "offline" }),
    ]);
  });

  test("delivers an approved call once, preserves heartbeat, and accepts only identical result retries", async () => {
    const device = await openSession(await redeem(await pair()));
    const pending = call();
    const command = await receive(device);
    expect(command).toMatchObject({
      toolName: "echo",
      arguments: { text: "hello" },
    });
    expect((await poll(device, false)).json()).toEqual({ command: null });
    expect((await poll(device)).json()).toEqual({ command: null });
    expect((await submit(device, command.id)).statusCode).toBe(200);
    expect((await submit(device, command.id)).statusCode).toBe(200);
    expect((await submit(device, command.id, "different")).statusCode).toBe(
      409,
    );
    expect(await pending).toMatchObject({
      error: null,
      result: { content: [{ type: "text", text: "hello" }] },
    });
    expect((await poll(device)).json()).toEqual({ command: null });
  });

  test("a new session cancels old work with an unknown outcome and never replays it", async () => {
    const device = await openSession(await redeem(await pair()));
    const pending = call();
    const command = await receive(device);
    const replacement = await openSession(device);
    expect(replacement.sessionId).not.toBe(device.sessionId);
    expect((await poll(device)).statusCode).toBe(409);
    expect((await submit(device, command.id)).statusCode).toBe(409);
    expect((await poll(replacement)).json()).toEqual({ command: null });
    expect(await pending).toMatchObject({
      error: { message: expect.stringContaining("unknown") },
    });
  });

  test("replacement requires explicit consent and revokes the old bearer", async () => {
    const device = await openSession(await redeem(await pair()));
    const rejected = await ctx.app.inject({
      method: "POST",
      url: "/api/device-mcp/pair",
      payload: { catalogId, name: "Another workstation" },
    });
    expect(rejected.statusCode).toBe(409);
    const replacement = await openSession(await redeem(await pair(true)));
    expect((await poll(device)).statusCode).toBe(401);
    expect((await poll(replacement)).statusCode).toBe(200);
  });

  test("another user cannot see, revoke or use a connection and another tenant cannot pair its catalog", async ({
    makeUser,
    makeMember,
    makeOrganization,
  }) => {
    const device = await openSession(await redeem(await pair()));
    const owner = ctx.user;
    const organizationId = ctx.organizationId;
    ctx.user = await makeUser();
    await makeMember(ctx.user.id, organizationId, { role: "admin" });
    expect(
      (
        await ctx.app.inject({
          method: "GET",
          url: `/api/device-mcp?catalogId=${catalogId}`,
        })
      ).json(),
    ).toEqual([]);
    expect(
      (
        await ctx.app.inject({
          method: "DELETE",
          url: `/api/device-mcp/${device.deviceId}`,
        })
      ).statusCode,
    ).toBe(404);
    expect(await call()).toMatchObject({
      error: { message: expect.stringContaining("Connect your own device") },
    });
    const otherOrg = await makeOrganization();
    await makeMember(ctx.user.id, otherOrg.id, { role: "admin" });
    await OrganizationModel.patch(otherOrg.id, { deviceMcpEnabled: true });
    ctx.organizationId = otherOrg.id;
    expect(
      (
        await ctx.app.inject({
          method: "POST",
          url: "/api/device-mcp/pair",
          payload: { catalogId, name: "Foreign workstation" },
        })
      ).statusCode,
    ).toBe(404);
    ctx.user = owner;
    ctx.organizationId = organizationId;
    expect((await poll(device)).statusCode).toBe(200);
  });

  test("revoking an active device refuses delivery and terminates its pending call", async () => {
    const device = await openSession(await redeem(await pair()));
    const pending = call();
    const command = await receive(device);
    expect(
      (
        await ctx.app.inject({
          method: "DELETE",
          url: `/api/device-mcp/${device.deviceId}`,
        })
      ).statusCode,
    ).toBe(200);
    expect((await poll(device)).statusCode).toBe(401);
    expect((await submit(device, command.id)).statusCode).toBe(401);
    expect(await pending).toMatchObject({
      error: { message: expect.stringContaining("unknown") },
    });
  });

  test("default-off blocks enrollment and a disabled opt-in blocks existing delivery", async () => {
    const device = await openSession(await redeem(await pair()));
    await OrganizationModel.patch(ctx.organizationId, {
      deviceMcpEnabled: false,
    });
    expect((await poll(device)).statusCode).toBe(401);
    expect(
      (
        await ctx.app.inject({
          method: "POST",
          url: "/api/device-mcp/pair",
          payload: {
            catalogId,
            name: "Disabled workstation",
            replaceExisting: true,
          },
        })
      ).statusCode,
    ).toBe(403);
    expect(await call()).toMatchObject({
      error: { message: expect.stringContaining("disabled") },
    });
    await OrganizationModel.patch(ctx.organizationId, {
      deviceMcpEnabled: true,
    });
    expect((await poll(device)).statusCode).toBe(401);
    expect(
      (
        await ctx.app.inject({
          method: "DELETE",
          url: `/api/device-mcp/${device.deviceId}`,
        })
      ).statusCode,
    ).toBe(200);
  });

  test("changed launch revision requires new consent and protocol mismatches are rejected", async () => {
    const device = await openSession(await redeem(await pair()));
    await InternalMcpCatalogModel.update(catalogId, {
      deviceConfig: { ...config, version: "2.0.0" },
    });
    expect((await poll(device)).statusCode).toBe(409);
    const states = await ctx.app.inject({
      method: "GET",
      url: `/api/device-mcp?catalogId=${catalogId}`,
    });
    expect(states.json()[0].status).toBe("update_required");
    const badProtocol = await ctx.app.inject({
      method: "POST",
      url: "/api/device-mcp/session",
      headers: { authorization: `Bearer ${device.token}` },
      payload: { configDigest: device.configDigest, protocolVersion: 2 },
    });
    expect(badProtocol.statusCode).toBe(400);
  });

  test("removing organization membership blocks existing device delivery", async () => {
    const device = await openSession(await redeem(await pair()));
    await MemberModel.deleteByMemberOrUserId(ctx.user.id, ctx.organizationId);
    expect((await poll(device)).statusCode).toBe(403);
    expect(await call()).toMatchObject({
      error: { message: expect.stringContaining("current human") },
    });
  });

  test("cancelled queued calls are never delivered and their arguments are cleared", async () => {
    const device = await openSession(await redeem(await pair()));
    const controller = new AbortController();
    const pending = call(controller.signal);
    await expect
      .poll(
        async () => {
          const [queued] = await db
            .select()
            .from(schema.deviceMcpCommandsTable)
            .where(eq(schema.deviceMcpCommandsTable.deviceId, device.deviceId));
          return queued?.status;
        },
        { timeout: 5000 },
      )
      .toBe("queued");
    controller.abort();
    expect((await pending).error).toBeTruthy();
    expect((await poll(device)).json()).toEqual({ command: null });
    const [cancelled] = await db
      .select()
      .from(schema.deviceMcpCommandsTable)
      .where(eq(schema.deviceMcpCommandsTable.deviceId, device.deviceId));
    expect(cancelled).toMatchObject({
      status: "unknown",
      arguments: {},
      result: null,
    });
    expect(await call(controller.signal)).toMatchObject({
      error: { message: expect.stringContaining("cancelled before dispatch") },
    });
    expect(
      await db
        .select()
        .from(schema.deviceMcpCommandsTable)
        .where(eq(schema.deviceMcpCommandsTable.deviceId, device.deviceId)),
    ).toHaveLength(1);
  });

  test("pairing exposes the resource id for safe audit snapshots and isolates snapshot tenants", async ({
    makeOrganization,
  }) => {
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/device-mcp/pair",
      payload: { catalogId, name: "Audited workstation" },
    });
    expect(response.statusCode, response.body).toBe(200);
    const pairing = response.json<Pairing & { id: string }>();
    const pendingSnapshot = await DeviceMcpModel.findByIdForAudit(
      pairing.id,
      ctx.organizationId,
    );
    expect(pendingSnapshot).toMatchObject({
      id: pairing.id,
      userId: ctx.user.id,
      catalogId,
      name: "Audited workstation",
      configVersion: config.version,
    });
    const device = await openSession(
      await redeem({ code: pairing.code, configDigest: pairing.configDigest }),
    );
    expect(device.deviceId).toBe(pairing.id);
    const connectedSnapshot = await DeviceMcpModel.findByIdForAudit(
      pairing.id,
      ctx.organizationId,
    );
    for (const snapshot of [pendingSnapshot, connectedSnapshot]) {
      for (const forbidden of [
        "pairingHash",
        "tokenHash",
        "sessionId",
        "pairingExpiresAt",
        "tokenExpiresAt",
      ]) {
        expect(snapshot).not.toHaveProperty(forbidden);
      }
      expect(JSON.stringify(snapshot)).not.toContain(pairing.code);
      expect(JSON.stringify(snapshot)).not.toContain(device.token);
    }
    const otherOrg = await makeOrganization();
    expect(
      await DeviceMcpModel.findByIdForAudit(pairing.id, otherOrg.id),
    ).toBeNull();
  });

  test("stale heartbeats fail fast and do not deliver queued execution after a timeout", async () => {
    const device = await openSession(await redeem(await pair()));
    // Clock is the only process boundary replaced; no storage/route/model is mocked.
    const realNow = Date.now;
    const { vi } = await import("vitest");
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + 16_000);
    try {
      expect(await call()).toMatchObject({
        error: { message: expect.stringContaining("offline") },
      });
    } finally {
      vi.mocked(Date.now).mockRestore();
    }
    await delay(1);
    expect((await poll(device)).json()).toEqual({ command: null });
  });
});
