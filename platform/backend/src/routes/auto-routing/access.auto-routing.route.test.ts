import { authPlugin } from "@/auth/fastify-plugin";
import config from "@/config";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import ServiceAccountModel from "@/models/service-account";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { configureAutoRouting } from "@/test/auto-routing";
import autoRoutingRoutes from "./auto-routing.routes";

const READS = [
  { method: "GET", url: "/api/auto-routing/settings" },
  { method: "GET", url: "/api/auto-routing/plans" },
  {
    method: "POST",
    url: "/api/auto-routing/simulate",
    payload: { budgetUsdPerDay: 50, volumeMultiplier: 2 },
  },
  { method: "GET", url: "/api/auto-routing/backfill" },
  { method: "GET", url: "/api/auto-routing/diagnostics" },
] as const;
const WRITES = [
  {
    method: "PUT",
    url: "/api/auto-routing/settings",
    payload: { enabled: false },
  },
  { method: "POST", url: "/api/auto-routing/replan" },
  {
    method: "POST",
    url: "/api/auto-routing/preview",
    payload: { text: "Fix a typo" },
  },
  { method: "POST", url: "/api/auto-routing/backfill/scan" },
  {
    method: "POST",
    url: "/api/auto-routing/backfill/score",
    payload: {
      backfillId: "00000000-0000-4000-8000-000000000001",
      scorerVersionId: "00000000-0000-4000-8000-000000000002",
      maxSessions: 10,
      maxCostUsd: 1,
    },
  },
  { method: "DELETE", url: "/api/auto-routing/backfill" },
] as const;

describe("auto routing API access", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;

  beforeEach(async ({ makeOrganization }) => {
    config.autoRouting.enabled = true;
    organizationId = (await makeOrganization()).id;
    await configureAutoRouting(organizationId);
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

  test("every route is not found while the feature is off", async () => {
    config.autoRouting.enabled = false;
    const authorization = await tokenFor("admin");

    for (const request of [
      ...READS,
      ...WRITES,
      { method: "GET", url: `/api/auto-routing/plans/${organizationId}` },
    ] as const) {
      const response = await app.inject({
        ...request,
        headers: { authorization },
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(404);
    }
  });

  test("a member reads but cannot change settings, re-plan, preview or backfill", async () => {
    const authorization = await tokenFor("member");

    for (const request of READS) {
      const response = await app.inject({
        ...request,
        headers: { authorization },
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(200);
    }
    for (const request of WRITES) {
      const response = await app.inject({
        ...request,
        headers: { authorization },
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
    }
    expect(await AutoRoutingSettingsModel.find(organizationId)).toMatchObject({
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

    for (const request of READS) {
      const response = await app.inject({
        ...request,
        headers: { authorization },
      });
      expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
    }
  });

  test("an admin passes the permission check on every write", async () => {
    const authorization = await tokenFor("admin");
    // Preview gets past the gate and stops at the missing scorer key; scoring
    // refuses an offer nobody made, and the cancel stops the scan.
    const expected = [200, 200, 400, 200, 409, 200];

    const statuses = [];
    for (const request of WRITES) {
      statuses.push(
        (await app.inject({ ...request, headers: { authorization } }))
          .statusCode,
      );
    }

    expect(statuses).toEqual(expected);
  });
});
