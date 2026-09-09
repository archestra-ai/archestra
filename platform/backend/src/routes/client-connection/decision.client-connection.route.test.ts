import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import { Authnz } from "@/auth/fastify-plugin/middleware";
import { CacheKey, cacheManager } from "@/cache-manager";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import ConnectionSetupModel from "@/models/connection-setup";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import routes from "./client-connection.routes";

vi.mock("@/cache-manager");
vi.mock("@/auth");

describe("browser-approved client connection", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  beforeEach(async ({ makeUser, makeOrganization, makeMember }) => {
    user = await makeUser();
    organizationId = (await makeOrganization()).id;
    await makeMember(user.id, organizationId);
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      request.user = user;
      request.organizationId = organizationId;
    });
    registerAuditLogHook(app);
    await app.register(routes);
  });
  afterEach(async () => {
    await app.close();
  });

  async function start() {
    const response = await app.inject({
      method: "POST",
      url: "/api/client-connections",
      payload: { clientId: "claude-code", platform: "linux" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    return response.json<{
      id: string;
      deviceCode: string;
      verificationPath: string;
    }>();
  }
  async function setup(
    overrides: {
      userId?: string;
      clientId?: "cursor";
      platform?: "windows";
    } = {},
  ) {
    return ConnectionSetupModel.create({
      organizationId,
      userId: user.id,
      clientId: "claude-code",
      platform: "linux",
      baseUrl: "http://localhost:3000/v1",
      expiresAt: new Date(Date.now() + 900_000),
      ...overrides,
    });
  }
  async function poll(deviceCode: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/client-connections/poll",
      payload: { deviceCode },
    });
    expect(response.statusCode).toBe(200);
    return response.json().status;
  }
  async function decide(id: string, setupId?: string) {
    return app.inject({
      method: "POST",
      url: `/api/client-connections/${id}/decision`,
      payload: setupId
        ? { decision: "approve", setupId }
        : { decision: "deny" },
    });
  }

  test("only approval binds an owned render ticket; it is single-use and audited without secrets", async () => {
    const pending = await start();
    const original = await setup();
    const installerToken = `archestra_con_${pending.deviceCode}`;
    expect(await poll(pending.deviceCode)).toBe("pending");
    expect(await ConnectionSetupModel.findByToken(installerToken)).toBeNull();
    const details = await app.inject({
      url: `/api/client-connections/${pending.id}`,
    });
    expect(details.json()).toMatchObject({
      clientId: "claude-code",
      platform: "linux",
    });
    expect(details.body).not.toContain(pending.deviceCode);
    expect(pending.verificationPath).not.toContain(pending.deviceCode);
    const approved = await decide(pending.id, original.setup.id);
    expect(approved.statusCode).toBe(200);
    expect(await poll(pending.deviceCode)).toBe("approved");
    expect(
      await ConnectionSetupModel.findByToken(original.rawToken),
    ).toBeNull();
    expect(
      (await ConnectionSetupModel.claimByToken({ rawToken: installerToken }))
        ?.id,
    ).toBe(original.setup.id);
    expect(
      await ConnectionSetupModel.claimByToken({ rawToken: installerToken }),
    ).toBeNull();
    expect((await decide(pending.id, original.setup.id)).statusCode).toBe(410);
    await vi.waitFor(async () => {
      const rows = await db
        .select()
        .from(schema.auditLogsTable)
        .where(
          and(
            eq(schema.auditLogsTable.resourceId, pending.id),
            eq(schema.auditLogsTable.outcome, "success"),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "clientConnection.updated",
        before: { status: "pending" },
        after: {
          status: "approved",
          clientId: "claude-code",
          platform: "linux",
        },
      });
      expect(JSON.stringify(rows)).not.toContain(pending.deviceCode);
    });
  });

  test("denial prevents binding and subsequent approval", async () => {
    const pending = await start();
    expect((await decide(pending.id)).statusCode).toBe(200);
    expect(await poll(pending.deviceCode)).toBe("denied");
    expect(
      (await decide(pending.id, (await setup()).setup.id)).statusCode,
    ).toBe(410);
    expect(
      await ConnectionSetupModel.findByToken(
        `archestra_con_${pending.deviceCode}`,
      ),
    ).toBeNull();
  });

  test("a different user's setup cannot be approved", async ({ makeUser }) => {
    const pending = await start();
    const other = await setup({ userId: (await makeUser()).id });
    expect((await decide(pending.id, other.setup.id)).statusCode).toBe(400);
    expect(await poll(pending.deviceCode)).toBe("denied");
    expect(
      await ConnectionSetupModel.findByToken(other.rawToken),
    ).not.toBeNull();
  });

  test.each([
    { clientId: "cursor" as const },
    { platform: "windows" as const },
  ])("rejects a mismatched setup %j", async (overrides) => {
    const pending = await start();
    expect(
      (await decide(pending.id, (await setup(overrides)).setup.id)).statusCode,
    ).toBe(400);
    expect(await poll(pending.deviceCode)).toBe("denied");
  });

  test("a consumed setup cannot be transferred to an installer", async () => {
    const pending = await start();
    const ticket = await setup();
    await ConnectionSetupModel.claimByToken({ rawToken: ticket.rawToken });
    expect((await decide(pending.id, ticket.setup.id)).statusCode).toBe(400);
    expect(await poll(pending.deviceCode)).toBe("denied");
  });

  test("an owned setup in another organization cannot be approved", async ({
    makeOrganization,
  }) => {
    const pending = await start();
    const other = await makeOrganization();
    const ticket = await ConnectionSetupModel.create({
      organizationId: other.id,
      userId: user.id,
      clientId: "claude-code",
      platform: "linux",
      baseUrl: "http://localhost:3000/v1",
      expiresAt: new Date(Date.now() + 900_000),
    });
    expect((await decide(pending.id, ticket.setup.id)).statusCode).toBe(400);
    expect(await poll(pending.deviceCode)).toBe("denied");
    expect(
      await ConnectionSetupModel.findByToken(ticket.rawToken),
    ).not.toBeNull();
  });

  test("unknown polling secrets cannot observe approval", async () => {
    const pending = await start();
    await decide(pending.id, (await setup()).setup.id);
    expect(await poll("A".repeat(43))).toBe("expired");
    expect(await poll(pending.deviceCode)).toBe("approved");
  });

  test("absolute expiry works even when cache cleanup has not run", async () => {
    const pending = await start();
    const now = Date.now();
    const spy = vi.spyOn(Date, "now").mockReturnValue(now + 600_001);
    try {
      expect(await poll(pending.deviceCode)).toBe("expired");
      expect((await decide(pending.id)).statusCode).toBe(410);
    } finally {
      spy.mockRestore();
    }
  });

  test("competing decisions have exactly one winner", async () => {
    const pending = await start();
    const ticket = await setup();
    const responses = await Promise.all([
      decide(pending.id, ticket.setup.id),
      decide(pending.id),
    ]);
    expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 410]);
  });

  test("creation is rate limited", async () => {
    for (let i = 0; i < 10; i++) await start();
    const response = await app.inject({
      method: "POST",
      url: "/api/client-connections",
      payload: { clientId: "cursor", platform: "macos" },
    });
    expect(response.statusCode).toBe(429);
  });

  test("losing pending cache state fails closed", async () => {
    const pending = await start();
    await cacheManager.delete(
      `${CacheKey.ClientConnection}-pending-${pending.id}`,
    );
    expect((await decide(pending.id)).statusCode).toBe(410);
  });
});

describe("client connection authentication boundary", () => {
  test("public bootstrap works without a session while review and decision require authentication", async () => {
    const app = createFastifyInstance();
    app.addHook("preHandler", new Authnz().handle);
    await app.register(routes);
    try {
      expect(
        (await app.inject({ url: "/api/client-connections/installer" }))
          .statusCode,
      ).toBe(200);
      const response = await app.inject({
        method: "POST",
        url: "/api/client-connections",
        payload: { clientId: "cursor", platform: "macos" },
      });
      expect(response.statusCode).toBe(200);
      const { id, deviceCode } = response.json();
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/client-connections/poll",
            payload: { deviceCode },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ url: `/api/client-connections/${id}` })).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/client-connections/${id}/decision`,
            payload: { decision: "deny" },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });
});
