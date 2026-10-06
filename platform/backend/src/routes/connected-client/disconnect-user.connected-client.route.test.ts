import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { ConnectedClientModel, ConnectionSetupModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("DELETE /api/connected-clients/users/:userId/:clientId", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let admin: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    admin = await makeUser();
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

  test("disconnects a member's client and drops them from the admin list", async ({
    makeUser,
    makeMember,
  }) => {
    const member = await makeUser();
    await makeMember(member.id, organizationId);
    await redeem(member.id);
    await redeem(admin.id);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/connected-clients/users/${member.id}/claude-code`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ setups: 1 });
    const { data } = await ConnectedClientModel.listConnectedUsers({
      organizationId,
      limit: 10,
      offset: 0,
    });
    expect(data.map((u) => u.userId)).toEqual([admin.id]);
  });

  test("returns 404 for a member of another organization", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const elsewhere = (await makeOrganization()).id;
    const outsider = await makeUser();
    await makeMember(outsider.id, elsewhere);
    await redeem(outsider.id, elsewhere);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/connected-clients/users/${outsider.id}/claude-code`,
    });

    expect(response.statusCode).toBe(404);
  });

  async function redeem(userId: string, orgId = organizationId) {
    const { rawToken } = await ConnectionSetupModel.create({
      organizationId: orgId,
      userId,
      clientId: "claude-code",
      platform: "macos",
      baseUrl: "http://localhost:9000/v1",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await ConnectionSetupModel.claimByToken({ rawToken });
  }
});
