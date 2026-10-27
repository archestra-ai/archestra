import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { diagnoseAutoRouting } from "@/auto-routing/diagnostics";
import { activeSourceVersion } from "@/auto-routing/signals";
import config from "@/config";
import db, { schema } from "@/database";
import { beforeEach, describe, expect, test } from "@/test";
import { configureAutoRouting, plannedDecision } from "@/test/auto-routing";
import { seedFitHistory } from "@/test/auto-routing-fit";
import { useRouteTestApp } from "@/test/route-test-app";
import { RoutingSessionKeySchema } from "@/types/auto-routing";
import type { AutoRoutingDiagnostics } from "@/types/auto-routing-api";
import autoRoutingRoutes from "./auto-routing.routes";

type Ready = Extract<AutoRoutingDiagnostics, { status: "ready" }>;

const SESSIONS = 60;
const HOUR = 60 * 60 * 1000;
const TIERS = ["fast", "normal", "smart"] as const;

/** Session i: a distinct Jev reading (p_long = i / 100 identifies it), client and age. */
function session(i: number, client = i % 3 === 0 ? "codex" : "claude-code") {
  const frac = (x: number) => x - Math.floor(x);
  const pFast = 0.9 * frac(i * 0.618);
  const pNormal = (1 - pFast) * frac(i * 0.414);
  return {
    client,
    createdAt: new Date(Date.now() - 2 * 24 * HOUR - i * 10 * HOUR),
    tierNeeded: [pFast, pNormal, 1 - pFast - pNormal] as const,
    pLong: i / 100,
  };
}

describe("GET /api/auto-routing/diagnostics", () => {
  const ctx = useRouteTestApp(autoRoutingRoutes);
  beforeEach(() => {
    config.autoRouting.enabled = true;
    config.autoRouting.minSessions = 30;
  });

  const diagnostics = (budgetUsdPerDay?: number) =>
    ctx.app.inject({
      method: "GET",
      url: "/api/auto-routing/diagnostics",
      query:
        budgetUsdPerDay === undefined
          ? {}
          : { budgetUsdPerDay: String(budgetUsdPerDay) },
    });

  const ready = async (budget?: number): Promise<Ready> => {
    const response = await diagnostics(budget);
    expect(response.statusCode, response.body).toBe(200);
    const body: AutoRoutingDiagnostics = response.json();
    if (body.status !== "ready") throw new Error(body.status);
    return body;
  };

  async function withActivePlan(clientOf?: (i: number) => string) {
    const trio = await configureAutoRouting(ctx.organizationId);
    const scorerVersionId = (await activeSourceVersion()).id;
    await seedFitHistory({
      organizationId: ctx.organizationId,
      modelId: trio[2].id,
      scorerVersionId,
      sessions: SESSIONS,
      session: (i) => {
        const s = session(i, clientOf?.(i));
        return {
          createdAt: s.createdAt,
          features: {
            signals: {
              "jev-session": {
                version: scorerVersionId,
                tier_needed: [...s.tierNeeded],
                p_long: s.pLong,
              },
            },
            client: s.client,
          },
        };
      },
    });
    const replanned = await ctx.app.inject({
      method: "POST",
      url: "/api/auto-routing/replan",
    });
    expect(replanned.json().fit.status, replanned.body).toBe("active");
  }

  test("routes every session to the tier its region implies, at every budget", async () => {
    await withActivePlan();
    const infeasible = (await diagnostics(0.01)).json();
    expect(infeasible.status).toBe("infeasible");
    const cheapest: number = infeasible.minBudgetUsdPerDay;

    const routedTiers = new Set<string>();
    for (const budget of [cheapest * 1.2, cheapest * 3, cheapest * 20]) {
      const body = await ready(budget);
      expect(body.budgetUsdPerDay).toBe(budget);
      for (const s of body.sessions) {
        const total = s.tierNeeded[0] + s.tierNeeded[1] + s.tierNeeded[2];
        const [pf, pn] = s.tierNeeded.map((p) => p / total);
        const score = [pf, pf + pn, 1].map(
          (adequacy, k) => adequacy - body.lamStar * s.usdPerToken[k],
        );
        const best = Math.max(...score);
        const inRegion = TIERS.filter((_, k) => score[k] >= best - 1e-9);
        expect(inRegion).toContain(s.tier);
        routedTiers.add(s.tier);
      }
    }
    expect(routedTiers.size).toBeGreaterThan(1);
  });

  test("its tier shares are the shown sessions' tiers, and both move with the budget", async () => {
    await withActivePlan();
    const cheapest: number = (await diagnostics(0.01)).json()
      .minBudgetUsdPerDay;

    const solved: Ready[] = [];
    for (const budget of [cheapest * 1.5, cheapest * 6]) {
      const body = await ready(budget);
      const dots = TIERS.map(
        (tier) =>
          body.sessions.filter((s) => s.tier === tier).length /
          body.sessions.length,
      );
      // The tie cohort is drawn per session, so its split is off by at most one session.
      for (const [k, share] of dots.entries()) {
        expect(Math.abs(share - body.tierSessionShare[k])).toBeLessThanOrEqual(
          1 / SESSIONS + 1e-9,
        );
      }
      solved.push(body);
    }

    const [low, high] = solved;
    expect(high.tierSessionShare[2]).toBeGreaterThan(low.tierSessionShare[2]);
    expect(high.lamStar).toBeLessThan(low.lamStar);
  });

  test("predicts sizes out of sample only for each client's latest 30%", async () => {
    await withActivePlan();

    const body = await ready();

    const indices = Array.from({ length: SESSIONS }, (_, i) => i);
    const expected = ["codex", "claude-code"].flatMap((client) =>
      indices
        .filter((i) => session(i).client === client)
        .toSorted((a, b) => +session(a).createdAt - +session(b).createdAt)
        .slice(Math.round((client === "codex" ? 20 : 40) * 0.7)),
    );
    const predicted = body.sessions
      .filter((s) => s.predictedTokens !== null)
      .map((s) => Math.round(s.pLong * 100));
    expect(predicted.toSorted((a, b) => a - b)).toEqual(
      expected.toSorted((a, b) => a - b),
    );
    expect(body.sizeFit).toMatchObject({
      status: "ok",
      testSessions: expected.length,
      plotted: expected.length,
      excluded: 0,
    });
    expect(body.sessions).toHaveLength(SESSIONS);
  });

  test("without a holdout it predicts no sizes", async () => {
    await withActivePlan((i) => `client-${i}`);

    const body = await ready();

    expect(body.sizeFit).toEqual({ status: "no_holdout" });
    expect(body.sessions.every((s) => s.predictedTokens === null)).toBe(true);
  });

  test("a budget change reuses the history and holdout fit until the organization records usage", async ({
    makeOrganization,
  }) => {
    await withActivePlan();
    const sizes = (body: Ready) =>
      body.sessions.map((s) => [s.pLong, s.predictedTokens]);
    const first = await ready();
    const budget = first.budgetUsdPerDay * 2;
    const own = eq(
      schema.routingDecisionsTable.organizationId,
      ctx.organizationId,
    );
    const [decision] = await db
      .select()
      .from(schema.routingDecisionsTable)
      .where(own)
      .limit(1);
    await db
      .update(schema.routingDecisionsTable)
      .set({
        features: sql`jsonb_set(features, '{signals,jev-session,p_long}', to_jsonb(1 - (features #>> '{signals,jev-session,p_long}')::float))`,
      })
      .where(own);
    const recordUsage = (decisionId: string) =>
      db.insert(schema.routingUsageTable).values({
        interactionId: randomUUID(),
        decisionId,
        input: 1,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
        output: 1,
        estimated: false,
      });

    const other = await makeOrganization();
    const [foreign] = await db
      .insert(schema.routingDecisionsTable)
      .values(
        plannedDecision({
          organizationId: other.id,
          sessionKey: RoutingSessionKeySchema.parse(randomUUID()),
          modelId: decision.modelId,
          scorerVersionId: (await activeSourceVersion()).id,
        }),
      )
      .returning();
    await recordUsage(foreign.id);
    const rebudgeted = await ready(budget);
    expect(rebudgeted.budgetUsdPerDay).toBe(budget);
    expect(sizes(rebudgeted)).toEqual(sizes(first));

    await recordUsage(decision.id);
    expect(sizes(await ready(budget))).not.toEqual(sizes(first));
  });

  test("without history drift the saved budget reproduces the active plan's shares", async () => {
    await withActivePlan();
    const plans = (
      await ctx.app.inject({ method: "GET", url: "/api/auto-routing/plans" })
    ).json();

    const body = await ready();

    expect(body.budgetUsdPerDay).toBe(body.savedBudgetUsdPerDay);
    expect(body.tierSessionShare).toEqual(plans[0].summary.tier_session_share);
  });

  test("without an active plan it reports a cold start", async () => {
    await configureAutoRouting(ctx.organizationId);

    const response = await diagnostics();

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ status: "cold_start" });
  });

  test("runs one per organization at a time and is not found while the feature is off", async () => {
    await withActivePlan();

    const statuses = (await Promise.all([diagnostics(), diagnostics()])).map(
      (response) => response.statusCode,
    );
    expect(statuses.sort()).toEqual([200, 429]);

    config.autoRouting.enabled = false;
    expect((await diagnostics()).statusCode).toBe(404);
  });

  test("refuses runs beyond the process-wide limit", async () => {
    const organizations = Array.from({ length: 5 }, () => crypto.randomUUID());

    const results = await Promise.allSettled(
      organizations.map((organizationId) =>
        diagnoseAutoRouting(organizationId, undefined),
      ),
    );

    expect(
      results.map((r) => (r.status === "rejected" ? r.reason.statusCode : 200)),
    ).toEqual([200, 200, 429, 429, 429]);
  });

  test("never refuses a simulation", async () => {
    await withActivePlan();

    const [diagnosed, simulated] = await Promise.all([
      diagnostics(),
      ctx.app.inject({
        method: "POST",
        url: "/api/auto-routing/simulate",
        payload: { budgetUsdPerDay: 50, volumeMultiplier: 1 },
      }),
    ]);

    expect([diagnosed.statusCode, simulated.statusCode]).toEqual([200, 200]);
  });
});
