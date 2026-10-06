import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { ConnectionSetupModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  authenticatedRouteApp,
  USER_HEADER,
} from "@/test/authenticated-route-app";
import type { User } from "@/types";

describe("GET /api/connected-clients/members", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let admin: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    admin = await makeUser({ name: "Admin" });
    await makeMember(admin.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & { organizationId: string; user: User }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = admin;
    });
    const { default: routes } = await import("./connected-client.routes");
    await app.register(routes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("lists every member, connected ones first, with their clients", async ({
    makeUser,
    makeMember,
  }) => {
    const ada = await makeUser({ name: "Ada" });
    await makeMember(ada.id, organizationId);
    await redeem(ada.id, "codex", "work-laptop");
    await redeem(ada.id, "claude-code", "work-laptop");
    await redeem(ada.id, "claude-code", "home-mac");
    // Started but never ran: not a connect.
    await ConnectionSetupModel.create({
      organizationId,
      userId: admin.id,
      clientId: "cursor",
      platform: "macos",
      baseUrl: "http://localhost:9000/v1",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/connected-clients/members?limit=10&offset=0",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.summary).toEqual({ memberCount: 2, connectedCount: 1 });
    expect(body.pagination.total).toBe(2);
    expect(body.data.map((m: { name: string }) => m.name)).toEqual([
      "Ada",
      "Admin",
    ]);
    const [connected, never] = body.data;
    expect(
      connected.clients.map((c: { clientId: string }) => c.clientId),
    ).toEqual(["claude-code", "codex"]);
    expect(connected.clients[0].deviceNames).toEqual([
      "home-mac",
      "work-laptop",
    ]);
    expect(connected.lastConnectedAt).toBe(
      connected.clients[0].lastConnectedAt,
    );
    expect(never).toMatchObject({ lastConnectedAt: null, clients: [] });
  });

  test("filters by status and search without changing the summary", async ({
    makeUser,
    makeMember,
  }) => {
    const ada = await makeUser({ name: "Ada Lovelace" });
    await makeMember(ada.id, organizationId);
    await redeem(ada.id, "codex");
    const grace = await makeUser({ name: "Grace Hopper" });
    await makeMember(grace.id, organizationId);

    const notConnected = (
      await app.inject({
        method: "GET",
        url: "/api/connected-clients/members?limit=10&offset=0&status=not_connected",
      })
    ).json();
    expect(notConnected.data.map((m: { name: string }) => m.name)).toEqual([
      "Admin",
      "Grace Hopper",
    ]);
    expect(notConnected.summary).toEqual({
      memberCount: 3,
      connectedCount: 1,
    });

    const searched = (
      await app.inject({
        method: "GET",
        url: "/api/connected-clients/members?limit=10&offset=0&status=connected&name=lovelace",
      })
    ).json();
    expect(searched.data.map((m: { name: string }) => m.name)).toEqual([
      "Ada Lovelace",
    ]);
  });

  test("leaves out other organizations' members and setups", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const otherOrgId = (await makeOrganization()).id;
    const outsider = await makeUser();
    await makeMember(outsider.id, otherOrgId);
    await redeem(outsider.id, "codex", undefined, otherOrgId);
    // An admin's setup in another org doesn't count here.
    await makeMember(admin.id, otherOrgId);
    await redeem(admin.id, "claude-code", undefined, otherOrgId);

    const body = (
      await app.inject({
        method: "GET",
        url: "/api/connected-clients/members?limit=10&offset=0",
      })
    ).json();

    expect(body.summary).toEqual({ memberCount: 1, connectedCount: 0 });
    expect(body.data).toEqual([
      expect.objectContaining({
        userId: admin.id,
        lastConnectedAt: null,
        clients: [],
      }),
    ]);
  });

  test.for([
    [ADMIN_ROLE_NAME, 200],
    [EDITOR_ROLE_NAME, 403],
    [MEMBER_ROLE_NAME, 403],
  ] as const)("is for admins only: %s gets %i", async ([role, statusCode], {
    makeUser,
    makeMember,
  }) => {
    const caller = await makeUser();
    await makeMember(caller.id, organizationId, { role });
    const { default: routes } = await import("./connected-client.routes");
    const gated = await authenticatedRouteApp({
      organizationId,
      routes: [routes],
    });
    try {
      const response = await gated.inject({
        method: "GET",
        url: "/api/connected-clients/members?limit=10&offset=0",
        headers: { [USER_HEADER]: caller.id },
      });
      expect(response.statusCode).toBe(statusCode);
    } finally {
      await gated.close();
    }
  });

  async function redeem(
    userId: string,
    clientId: "claude-code" | "codex",
    deviceName?: string,
    orgId = organizationId,
  ) {
    const { rawToken } = await ConnectionSetupModel.create({
      organizationId: orgId,
      userId,
      clientId,
      platform: "macos",
      deviceName,
      baseUrl: "http://localhost:9000/v1",
      expiresAt: new Date(Date.now() + 60_000),
    });
    // Redeems in one millisecond tie on consumedAt, and the list orders by it.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await ConnectionSetupModel.claimByToken({ rawToken });
  }
});
