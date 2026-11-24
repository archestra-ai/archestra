import { authPlugin } from "@/auth/fastify-plugin";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import AutoRouterModel from "@/models/auto-router";
import ServiceAccountModel from "@/models/service-account";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { autoRouterId, configureAutoRouting } from "@/test/auto-routing";
import autoRoutingRoutes from "./auto-routing.routes";

const reads = (routerId: string) =>
  [
    { method: "GET", url: "/api/auto-routing/state" },
    { method: "GET", url: "/api/auto-routing/routers" },
    { method: "GET", url: "/api/auto-routing/routers/available" },
    { method: "GET", url: `/api/auto-routing/routers/${routerId}` },
    { method: "GET", url: `/api/auto-routing/routers/${routerId}/plans` },
    { method: "GET", url: `/api/auto-routing/routers/${routerId}/usage` },
    {
      method: "POST",
      url: `/api/auto-routing/routers/${routerId}/simulate`,
      payload: { budgetUsdPerDay: 50, volumeMultiplier: 2 },
    },
    { method: "GET", url: `/api/auto-routing/routers/${routerId}/diagnostics` },
  ] as const;
const writes = (routerId: string) =>
  [
    {
      method: "PUT",
      url: "/api/auto-routing/state",
      payload: { enabled: false },
    },
    {
      method: "PUT",
      url: `/api/auto-routing/routers/${routerId}`,
      payload: { budgetUsdPerDay: 60 },
    },
    { method: "POST", url: `/api/auto-routing/routers/${routerId}/replan` },
    {
      method: "POST",
      url: `/api/auto-routing/routers/${routerId}/preview`,
      payload: { text: "Fix a typo" },
    },
    { method: "DELETE", url: `/api/auto-routing/routers/${routerId}` },
  ] as const;

describe("auto routing API access", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let routerId: string;

  beforeEach(async ({ makeOrganization }) => {
    organizationId = (await makeOrganization()).id;
    await configureAutoRouting(organizationId);
    routerId = await autoRouterId(organizationId);
    app = createFastifyInstance();
    await app.register(authPlugin);
    await app.register(autoRoutingRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function tokenFor(role: string) {
    const account = await ServiceAccountModel.create({
      organizationId,
      name: `auto-routing-${role}`,
      role,
      createdBy: null,
    });
    const { token } = await ServiceAccountModel.createToken({
      serviceAccountId: account.id,
      organizationId,
      name: role,
    });
    return token;
  }

  test("a member reads but cannot change routers, re-plan or preview", async () => {
    const authorization = await tokenFor("member");

    for (const request of reads(routerId)) {
      const response = await app.inject({
        ...request,
        headers: { authorization },
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(200);
    }
    for (const request of writes(routerId)) {
      const response = await app.inject({
        ...request,
        headers: { authorization },
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
    }
    expect(await AutoRouterModel.find(routerId)).toMatchObject({
      enabled: true,
      generation: 1,
    });
  });

  test("a role without LLM proxy read access cannot read", async ({
    makeCustomRole,
  }) => {
    const role = await makeCustomRole(organizationId, {
      permission: { agent: ["read"] },
    });
    const authorization = await tokenFor(role.role);

    for (const request of reads(routerId)) {
      const response = await app.inject({
        ...request,
        headers: { authorization },
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
    }
  });

  test("an admin passes the permission check on every write", async () => {
    const authorization = await tokenFor("admin");
    // Preview gets past the gate and stops at the missing scorer key.
    const expected = [200, 200, 200, 400, 200];

    const statuses = [];
    for (const request of writes(routerId)) {
      statuses.push(
        (await app.inject({ ...request, headers: { authorization } }))
          .statusCode,
      );
    }

    expect(statuses).toEqual(expected);
  });
});
