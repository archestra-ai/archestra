import { simulateFit } from "@/auto-routing/fit";
import { activeSourceVersion } from "@/auto-routing/signals";
import config from "@/config";
import db, { schema } from "@/database";
import AutoRoutingSettingsModel from "@/models/auto-routing-settings";
import RoutingPlanModel from "@/models/routing-plan";
import { beforeEach, describe, expect, test } from "@/test";
import { configureAutoRouting } from "@/test/auto-routing";
import { seedFitHistory } from "@/test/auto-routing-fit";
import { useRouteTestApp } from "@/test/route-test-app";
import autoRoutingRoutes from "./auto-routing.routes";

type Summary = {
  expected_spend: number;
  value_size_weighted: number;
  tokens_per_day: number;
  sessions_per_day: number;
};

describe("POST /api/auto-routing/simulate", () => {
  const ctx = useRouteTestApp(autoRoutingRoutes);
  beforeEach(() => {
    config.autoRouting.enabled = true;
    config.autoRouting.minSessions = 30;
  });

  const simulate = (budgetUsdPerDay: number, volumeMultiplier = 1) =>
    ctx.app.inject({
      method: "POST",
      url: "/api/auto-routing/simulate",
      payload: { budgetUsdPerDay, volumeMultiplier },
    });

  const feasibleResponse = async (budget: number, multiplier = 1) => {
    const response = await simulate(budget, multiplier);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.status).toBe("feasible");
    return body as {
      summary: Summary;
      tiersFingerprint: { tiers: { model_id: string }[] };
      baseline: { sessionsPerDay: number; tokensPerDay: number };
    };
  };
  const feasible = async (budget: number, multiplier = 1) =>
    (await feasibleResponse(budget, multiplier)).summary;

  const minBudget = async (multiplier = 1) => {
    const response = await simulate(0.01, multiplier);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.status).toBe("infeasible");
    return body.minBudgetUsdPerDay as number;
  };

  async function withHistory(sessions = 40) {
    const trio = await configureAutoRouting(ctx.organizationId);
    await seedFitHistory({
      organizationId: ctx.organizationId,
      modelId: trio[2].id,
      scorerVersionId: (await activeSourceVersion()).id,
      sessions,
    });
    return trio;
  }

  test("spends the whole budget when it lies between the cheapest and the all-smart routing", async () => {
    await withHistory();
    const cheapest = await minBudget();
    const allSmart = (await feasible(1_000_000)).expected_spend;
    expect(allSmart).toBeGreaterThan(cheapest);
    const budget = Math.round((cheapest + allSmart) * 50) / 100;

    const summary = await feasible(budget);

    expect(summary.expected_spend).toBeCloseTo(budget, 6);
  });

  test("more traffic at the same budget lowers quality and scales volume", async () => {
    await withHistory();
    const cheapest = await minBudget();
    const allSmart = (await feasible(1_000_000)).expected_spend;
    const budget = Math.round((cheapest + allSmart) * 50) / 100;

    const base = await feasible(budget, 1);
    const tripled = await feasible(budget, 3);

    expect(tripled.value_size_weighted).toBeLessThan(base.value_size_weighted);
    expect(tripled.tokens_per_day).toBeCloseTo(3 * base.tokens_per_day, 6);
    expect(tripled.sessions_per_day).toBeCloseTo(3 * base.sessions_per_day, 9);
  });

  test("reports the tiers it fitted and the unscaled traffic it scaled", async () => {
    const trio = await withHistory();
    const cheapest = await minBudget();
    const allSmart = (await feasible(1_000_000)).expected_spend;
    const budget = Math.round((cheapest + allSmart) * 50) / 100;

    const base = await feasibleResponse(budget, 1);
    const tripled = await feasibleResponse(budget, 3);

    expect(tripled.tiersFingerprint.tiers.map((t) => t.model_id)).toEqual(
      trio.map((model) => model.id),
    );
    expect(tripled.baseline).toEqual(base.baseline);
    expect(base.baseline.tokensPerDay).toBeCloseTo(
      base.summary.tokens_per_day,
      6,
    );
    expect(tripled.summary.sessions_per_day).toBeCloseTo(
      3 * tripled.baseline.sessionsPerDay,
      9,
    );
  });

  test("runs one simulation per organization at a time", async () => {
    await withHistory();

    const statuses = (
      await Promise.all([simulate(50, 1), simulate(50, 2)])
    ).map((response) => response.statusCode);

    expect(statuses.sort()).toEqual([200, 429]);
    expect((await simulate(50, 2)).statusCode).toBe(200);
  });

  test("refuses simulations beyond the process-wide limit", async () => {
    const organizations = Array.from({ length: 5 }, () => crypto.randomUUID());

    const results = await Promise.allSettled(
      organizations.map((organizationId) =>
        simulateFit(organizationId, {
          budgetUsdPerDay: 50,
          volumeMultiplier: 1,
        }),
      ),
    );

    const statuses = results.map((result) =>
      result.status === "rejected" ? result.reason.statusCode : 200,
    );
    expect(statuses).toEqual([400, 400, 400, 400, 429]);
    await expect(
      simulateFit(organizations[4], {
        budgetUsdPerDay: 50,
        volumeMultiplier: 1,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test("an infeasible budget reports the cheapest routing, which scales with traffic", async () => {
    await withHistory();

    const single = await minBudget(1);
    const doubled = await minBudget(2);

    expect(single).toBeGreaterThan(0);
    expect(doubled).toBeCloseTo(2 * single, 1);
    expect((await simulate(single)).json().status).toBe("feasible");
  });

  test("at the saved budget and current volume it matches the plan a re-plan publishes, without publishing", async () => {
    await withHistory();
    const before = await AutoRoutingSettingsModel.find(ctx.organizationId);

    const simulated = await feasible(50);

    expect(await db.$count(schema.routingPlansTable)).toBe(0);
    expect(await AutoRoutingSettingsModel.find(ctx.organizationId)).toEqual(
      before,
    );
    const replanned = await ctx.app.inject({
      method: "POST",
      url: "/api/auto-routing/replan",
    });
    expect(replanned.statusCode, replanned.body).toBe(200);
    const active = await RoutingPlanModel.findActive(ctx.organizationId);
    expect(active?.summary).toEqual(simulated);
  });

  test("below the session minimum it reports the cold-start progress", async () => {
    await withHistory(10);

    const response = await simulate(50, 2);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      status: "cold_start",
      sessions: 10,
      required: 30,
    });
  });

  test("needs every tier model", async () => {
    const response = await simulate(50);

    expect(response.statusCode, response.body).toBe(400);
  });
});
