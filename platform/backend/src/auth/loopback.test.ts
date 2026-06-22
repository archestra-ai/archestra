import { RouteId } from "@archestra/shared";
import { fastifyAuthPlugin, loopbackGateway } from "@/auth";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

// A permissioned read (toolPolicy:read) and an any-authenticated read, used to
// prove loopback requests run the real RBAC the UI would.
const PERMISSIONED_PATH = "/api/__loopback_permissioned";
const OPEN_PATH = "/api/__loopback_open";

describe("loopback gateway", () => {
  let app: FastifyInstanceWithZod;
  let adminUser: User;
  let limitedUser: User;
  let organizationId: string;

  beforeEach(
    async ({
      makeOrganization,
      makeAdmin,
      makeUser,
      makeMember,
      makeCustomRole,
    }) => {
      const organization = await makeOrganization();
      organizationId = organization.id;

      adminUser = await makeAdmin();
      await makeMember(adminUser.id, organizationId, { role: "admin" });

      const noPermissionsRole = await makeCustomRole(organizationId, {
        permission: {},
      });
      limitedUser = await makeUser();
      await makeMember(limitedUser.id, organizationId, {
        role: noPermissionsRole.role,
      });

      app = createFastifyInstance();
      await app.register(fastifyAuthPlugin);
      app.get(
        PERMISSIONED_PATH,
        { schema: { operationId: RouteId.GetTools } },
        async () => ({ ok: true }),
      );
      app.get(
        OPEN_PATH,
        { schema: { operationId: RouteId.GetAgents } },
        async () => ({ ok: true }),
      );
      loopbackGateway.setServer(app);
      await app.ready();
    },
  );

  afterEach(async () => {
    await app.close();
  });

  test("runs a request as the given user and enforces route RBAC", async () => {
    const asAdmin = await loopbackGateway.request({
      method: "GET",
      path: PERMISSIONED_PATH,
      userId: adminUser.id,
      organizationId,
    });
    expect(asAdmin.status).toBe(200);
    expect(asAdmin.body).toEqual({ ok: true });

    const asLimited = await loopbackGateway.request({
      method: "GET",
      path: PERMISSIONED_PATH,
      userId: limitedUser.id,
      organizationId,
    });
    expect(asLimited.status).toBe(403);
  });

  test("a user without the permission still passes routes that need none", async () => {
    const response = await loopbackGateway.request({
      method: "GET",
      path: OPEN_PATH,
      userId: limitedUser.id,
      organizationId,
    });
    expect(response.status).toBe(200);
  });

  test("a request without a valid loopback nonce is rejected", async () => {
    const response = await app.inject({ method: "GET", url: OPEN_PATH });
    expect(response.statusCode).toBe(401);
  });

  test("resolve returns null for an unknown nonce", () => {
    expect(loopbackGateway.resolve("not-a-real-nonce")).toBeNull();
  });
});
