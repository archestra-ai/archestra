import {
  ADMIN_ROLE_NAME,
  EDITOR_ROLE_NAME,
  MEMBER_ROLE_NAME,
} from "@archestra/shared";
import { withDbTransaction } from "@/database";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { ConnectedClientModel, ConnectionSetupModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import {
  authenticatedRouteApp,
  USER_HEADER,
} from "@/test/authenticated-route-app";
import type { ConnectionSetupClientId, User } from "@/types";

describe("GET /api/connected-clients/log", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let admin: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    admin = await makeUser({ name: "Admin" });
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });

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

  const getLog = async (query = "") => {
    const response = await app.inject({
      method: "GET",
      url: `/api/connected-clients/log?limit=10&offset=0${query}`,
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  };

  test("logs each redeemed setup, newest first", async ({
    makeUser,
    makeMember,
    makeAgent,
  }) => {
    const ada = await makeUser({ name: "Ada Lovelace" });
    await makeMember(ada.id, organizationId);
    const gateway = await makeAgent({
      organizationId,
      name: "Engineering tools",
      agentType: "mcp_gateway",
    });
    await redeem(ada.id, "codex", { deviceName: "work-laptop" });
    await redeem(ada.id, "claude-code", {
      deviceName: "home-mac",
      mcpGatewayId: gateway.id,
    });
    // Started but never ran: not a connection.
    await ConnectionSetupModel.create({
      organizationId,
      userId: admin.id,
      clientId: "cursor",
      platform: "macos",
      baseUrl: "http://localhost:9000/v1",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const body = await getLog();

    expect(body.pagination.total).toBe(2);
    expect(body.data).toEqual([
      expect.objectContaining({
        userName: "Ada Lovelace",
        clientId: "claude-code",
        deviceName: "home-mac",
        mcpGateway: { id: gateway.id, name: "Engineering tools" },
        modelRouting: false,
        disconnectedAt: null,
      }),
      expect.objectContaining({
        clientId: "codex",
        deviceName: "work-laptop",
        mcpGateway: null,
      }),
    ]);
  });

  test("keeps disconnected agents, marked as such", async ({
    makeUser,
    makeMember,
  }) => {
    const ada = await makeUser();
    await makeMember(ada.id, organizationId);
    await redeem(ada.id, "codex");
    await withDbTransaction((tx) =>
      ConnectedClientModel.revokeForUser({
        organizationId,
        userId: ada.id,
        clientId: "codex",
        revokedByUserId: ada.id,
        tx,
      }),
    );

    const [entry] = (await getLog()).data;
    expect(entry.disconnectedAt).toEqual(expect.any(String));
  });

  test("filters by agent and by the user's name or email", async ({
    makeUser,
    makeMember,
  }) => {
    const ada = await makeUser({ name: "Ada Lovelace" });
    await makeMember(ada.id, organizationId);
    const grace = await makeUser({ name: "Grace Hopper" });
    await makeMember(grace.id, organizationId);
    await redeem(ada.id, "codex");
    await redeem(grace.id, "codex");
    await redeem(grace.id, "cursor");

    const names = (body: { data: { userName: string }[] }) =>
      body.data.map((entry) => entry.userName);
    expect(names(await getLog("&clientId=cursor"))).toEqual(["Grace Hopper"]);
    expect(names(await getLog("&search=lovelace"))).toEqual(["Ada Lovelace"]);
  });

  test("leaves out other organizations' connections", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const otherOrgId = (await makeOrganization()).id;
    const outsider = await makeUser();
    await makeMember(outsider.id, otherOrgId);
    await redeem(outsider.id, "codex", { organizationId: otherOrgId });

    expect((await getLog()).data).toEqual([]);
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
        url: "/api/connected-clients/log?limit=10&offset=0",
        headers: { [USER_HEADER]: caller.id },
      });
      expect(response.statusCode).toBe(statusCode);
    } finally {
      await gated.close();
    }
  });

  async function redeem(
    userId: string,
    clientId: ConnectionSetupClientId,
    options: {
      deviceName?: string;
      mcpGatewayId?: string;
      organizationId?: string;
    } = {},
  ) {
    const { rawToken } = await ConnectionSetupModel.create({
      organizationId: options.organizationId ?? organizationId,
      userId,
      clientId,
      platform: "macos",
      deviceName: options.deviceName,
      mcpGatewayId: options.mcpGatewayId,
      baseUrl: "http://localhost:9000/v1",
      expiresAt: new Date(Date.now() + 60_000),
    });
    // Redeems in one millisecond tie on consumedAt, and the log orders by it.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await ConnectionSetupModel.claimByToken({ rawToken });
  }
});
