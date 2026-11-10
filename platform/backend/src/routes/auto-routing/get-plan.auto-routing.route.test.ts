import { randomUUID } from "node:crypto";
import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import {
  autoRouterId,
  configureAutoRouting,
  publishFittedPlan,
} from "@/test/auto-routing";
import { useRouteTestApp } from "@/test/route-test-app";
import autoRoutingRoutes from "./auto-routing.routes";

describe("GET /api/auto-routing/routers/:id/plans/:planId", () => {
  const ctx = useRouteTestApp(autoRoutingRoutes);
  beforeEach(() => {
    config.autoRouting.enabled = true;
  });

  const getPlan = (routerId: string, id: string) =>
    ctx.app.inject({
      method: "GET",
      url: `/api/auto-routing/routers/${routerId}/plans/${id}`,
    });

  test("returns the fitted plan document and the tiers it was fitted for", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);
    const plan = await publishFittedPlan({
      organizationId: ctx.organizationId,
      trio,
    });

    const response = await getPlan(plan.routerId, plan.id);

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      id: plan.id,
      status: "active",
      decisionCount: 0,
      tiersFingerprint: plan.tiersFingerprint,
      plan: plan.plan,
    });
    expect(body.plan).toHaveProperty("size_model");
    expect(body.plan).toHaveProperty("long_share");
  });

  test("another organization's plan is not found", async ({
    makeOrganization,
  }) => {
    const other = await makeOrganization();
    const plan = await publishFittedPlan({
      organizationId: other.id,
      trio: await configureAutoRouting(other.id),
    });
    await configureAutoRouting(ctx.organizationId);
    const ownRouterId = await autoRouterId(ctx.organizationId);

    expect((await getPlan(plan.routerId, plan.id)).statusCode).toBe(404);
    expect((await getPlan(ownRouterId, plan.id)).statusCode).toBe(404);
    expect((await getPlan(ownRouterId, randomUUID())).statusCode).toBe(404);
  });
});
