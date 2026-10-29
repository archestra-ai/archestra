import { randomUUID } from "node:crypto";
import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";
import { configureAutoRouting, publishFittedPlan } from "@/test/auto-routing";
import { useRouteTestApp } from "@/test/route-test-app";
import autoRoutingRoutes from "./auto-routing.routes";

describe("GET /api/auto-routing/plans/:id", () => {
  const ctx = useRouteTestApp(autoRoutingRoutes);
  beforeEach(() => {
    config.autoRouting.enabled = true;
  });

  const getPlan = (id: string) =>
    ctx.app.inject({ method: "GET", url: `/api/auto-routing/plans/${id}` });

  test("returns the fitted plan document and the tiers it was fitted for", async () => {
    const trio = await configureAutoRouting(ctx.organizationId);
    const plan = await publishFittedPlan({
      organizationId: ctx.organizationId,
      trio,
    });

    const response = await getPlan(plan.id);

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

    expect((await getPlan(plan.id)).statusCode).toBe(404);
    expect((await getPlan(randomUUID())).statusCode).toBe(404);
  });
});
