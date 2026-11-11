import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import AutoRouterModel from "@/models/auto-router";
import RoutingPlanModel from "@/models/routing-plan";
import { describe, expect, test } from "@/test";
import {
  activeFit,
  ensureAutoRouter,
  makeScorerVersion,
} from "@/test/auto-routing";

describe("RoutingPlanModel.publish", () => {
  test("concurrent first publications leave exactly one active plan", async ({
    makeOrganization,
  }) => {
    const { organizationId, routerId, scorerVersionId, generation } =
      await setup(makeOrganization);
    const watermark = new Date();

    const results = await Promise.all(
      ["a", "b", "c"].map((label) =>
        RoutingPlanModel.publish(
          activeFit({
            organizationId,
            routerId,
            scorerVersionId,
            generation,
            inputWatermark: watermark,
            label,
          }),
        ),
      ),
    );

    expect(results.every((result) => result.kind === "recorded")).toBe(true);
    expect(await statuses(organizationId)).toEqual({
      active: 1,
      superseded: 2,
    });
  });

  test("a newer fit replaces the active plan and marks its generation planned", async ({
    makeOrganization,
  }) => {
    const { organizationId, routerId, scorerVersionId, generation } =
      await setup(makeOrganization);
    await AutoRouterModel.update(routerId, {});
    const first = await RoutingPlanModel.publish(
      activeFit({
        organizationId,
        routerId,
        scorerVersionId,
        generation: generation + 1,
        inputWatermark: new Date("2026-01-01T00:00:00Z"),
        label: "first",
      }),
    );
    const second = await RoutingPlanModel.publish(
      activeFit({
        organizationId,
        routerId,
        scorerVersionId,
        generation: generation + 1,
        inputWatermark: new Date("2026-01-02T00:00:00Z"),
        label: "second",
      }),
    );

    expect(second.kind).toBe("recorded");
    expect((await RoutingPlanModel.findActive(routerId))?.plan).toEqual({
      label: "second",
    });
    const [superseded] = await db
      .select({ status: schema.routingPlansTable.status })
      .from(schema.routingPlansTable)
      .where(eq(schema.routingPlansTable.id, first.plan.id));
    expect(superseded.status).toBe("superseded");
    expect((await AutoRouterModel.find(routerId))?.plannedGeneration).toBe(
      generation + 1,
    );
  });

  test("a fit over older usage than the active plan loses", async ({
    makeOrganization,
  }) => {
    const { organizationId, routerId, scorerVersionId, generation } =
      await setup(makeOrganization);
    await RoutingPlanModel.publish(
      activeFit({
        organizationId,
        routerId,
        scorerVersionId,
        generation,
        inputWatermark: new Date("2026-01-02T00:00:00Z"),
        label: "newer",
      }),
    );

    const stale = await RoutingPlanModel.publish(
      activeFit({
        organizationId,
        routerId,
        scorerVersionId,
        generation,
        inputWatermark: new Date("2026-01-01T00:00:00Z"),
        label: "older",
      }),
    );

    expect(stale).toMatchObject({
      kind: "rejected",
      reason: "stale_watermark",
      plan: { status: "rejected", error: "stale_watermark", plan: null },
    });
    expect((await RoutingPlanModel.findActive(routerId))?.plan).toEqual({
      label: "newer",
    });
  });

  test("a settings change while a fit runs makes that fit lose and leaves the organization due for a fit", async ({
    makeOrganization,
  }) => {
    const { organizationId, routerId, scorerVersionId } =
      await setup(makeOrganization);
    const read = await AutoRouterModel.find(routerId);
    if (!read) throw new Error("settings missing");

    // The fit read `read`; the settings write commits before the fit publishes.
    await AutoRouterModel.update(routerId, {
      budgetUsdPerDay: "10.00",
    });
    const published = await RoutingPlanModel.publish(
      activeFit({
        organizationId,
        routerId,
        scorerVersionId,
        generation: read.generation,
        inputWatermark: new Date(),
      }),
    );

    expect(published).toMatchObject({
      kind: "rejected",
      reason: "stale_generation",
    });
    expect(await RoutingPlanModel.findActive(routerId)).toBeNull();
    const settings = await AutoRouterModel.find(routerId);
    expect(settings?.budgetUsdPerDay).toBe("10.00");
    expect(settings && settings.generation > settings.plannedGeneration).toBe(
      true,
    );
  });

  test("a scorer activation during a fit makes that fit lose", async ({
    makeOrganization,
  }) => {
    const { organizationId, routerId, scorerVersionId, generation } =
      await setup(makeOrganization);
    const newer = await makeScorerVersion();

    await AutoRouterModel.activateScorerVersion(routerId, newer.id);
    const published = await RoutingPlanModel.publish(
      activeFit({
        organizationId,
        routerId,
        scorerVersionId,
        generation,
        inputWatermark: new Date(),
      }),
    );

    expect(published).toMatchObject({ reason: "stale_generation" });
  });

  test("a cold start retires the active plan and a failed fit keeps it", async ({
    makeOrganization,
  }) => {
    const { organizationId, routerId, scorerVersionId, generation } =
      await setup(makeOrganization);
    const base = {
      organizationId,
      routerId,
      scorerVersionId,
      generation,
      inputWatermark: new Date(),
    };
    await RoutingPlanModel.publish(activeFit({ ...base, label: "serving" }));

    await RoutingPlanModel.publish({
      ...activeFit(base),
      outcome: { status: "failed", error: "solver failed", diagnostics: null },
    });
    expect((await RoutingPlanModel.findActive(routerId))?.plan).toEqual({
      label: "serving",
    });

    await RoutingPlanModel.publish({
      ...activeFit(base),
      outcome: { status: "cold_start", summary: null, diagnostics: null },
    });
    expect(await RoutingPlanModel.findActive(routerId)).toBeNull();
  });

  test("a fit for another scorer version than the organization's loses", async ({
    makeOrganization,
  }) => {
    const { organizationId, routerId, generation } =
      await setup(makeOrganization);
    const other = await makeScorerVersion();

    const published = await RoutingPlanModel.publish(
      activeFit({
        organizationId,
        routerId,
        scorerVersionId: other.id,
        generation,
        inputWatermark: new Date(),
      }),
    );

    expect(published).toMatchObject({
      kind: "rejected",
      reason: "stale_scorer_version",
    });
    expect(await RoutingPlanModel.findActive(routerId)).toBeNull();
  });

  test("a cold start still fences fits over older usage", async ({
    makeOrganization,
  }) => {
    const { organizationId, routerId, scorerVersionId, generation } =
      await setup(makeOrganization);
    const fit = (day: string) =>
      activeFit({
        organizationId,
        routerId,
        scorerVersionId,
        generation,
        inputWatermark: new Date(`2026-01-0${day}T00:00:00Z`),
      });
    await RoutingPlanModel.publish(fit("2"));
    await RoutingPlanModel.publish({
      ...fit("3"),
      outcome: { status: "cold_start", summary: null, diagnostics: null },
    });

    const older = await RoutingPlanModel.publish(fit("1"));

    expect(older).toMatchObject({
      kind: "rejected",
      reason: "stale_watermark",
    });
    expect(await RoutingPlanModel.findActive(routerId)).toBeNull();
  });
});

describe("routers of one organization", () => {
  test("publishing a plan for one router leaves the other without an active plan", async ({
    makeOrganization,
  }) => {
    const a = await setup(makeOrganization);
    const routerB = await ensureAutoRouter(a.organizationId, "auto:b");
    await AutoRouterModel.activateScorerVersion(routerB.id, a.scorerVersionId);

    const published = await RoutingPlanModel.publish(
      activeFit({
        organizationId: a.organizationId,
        routerId: a.routerId,
        scorerVersionId: a.scorerVersionId,
        generation: a.generation,
        inputWatermark: new Date(),
      }),
    );

    expect(published.kind).toBe("recorded");
    expect(await RoutingPlanModel.findActive(a.routerId)).not.toBeNull();
    expect(await RoutingPlanModel.findActive(routerB.id)).toBeNull();
  });

  test("updating one router leaves the other's generation untouched", async ({
    makeOrganization,
  }) => {
    const a = await setup(makeOrganization);
    const routerB = await ensureAutoRouter(a.organizationId, "auto:b");

    await AutoRouterModel.update(routerB.id, { budgetUsdPerDay: "10.00" });
    await AutoRouterModel.update(routerB.id, {});

    expect((await AutoRouterModel.find(routerB.id))?.generation).toBe(
      routerB.generation + 2,
    );
    expect((await AutoRouterModel.find(a.routerId))?.generation).toBe(
      a.generation,
    );
  });
});

describe("AutoRouterModel.activateScorerVersion", () => {
  test("concurrent activations of one version bump the generation once", async ({
    makeOrganization,
  }) => {
    const { routerId, generation } = await setup(makeOrganization);
    const newer = await makeScorerVersion();

    const changed = await Promise.all(
      Array.from({ length: 5 }, () =>
        AutoRouterModel.activateScorerVersion(routerId, newer.id),
      ),
    );

    expect(changed.filter(Boolean)).toHaveLength(1);
    expect(await AutoRouterModel.find(routerId)).toMatchObject({
      scorerVersionId: newer.id,
      generation: generation + 1,
    });
  });
});

/** An organization whose `auto` router runs a fresh scorer version, at its resulting generation. */
async function setup(makeOrganization: () => Promise<{ id: string }>) {
  const organization = await makeOrganization();
  const router = await ensureAutoRouter(organization.id);
  const scorer = await makeScorerVersion();
  await AutoRouterModel.activateScorerVersion(router.id, scorer.id);
  const settings = await AutoRouterModel.find(router.id);
  if (!settings) throw new Error("settings missing");
  return {
    organizationId: organization.id,
    routerId: router.id,
    scorerVersionId: scorer.id,
    generation: settings.generation,
  };
}

async function statuses(organizationId: string) {
  const rows = await db
    .select({ status: schema.routingPlansTable.status })
    .from(schema.routingPlansTable)
    .where(eq(schema.routingPlansTable.organizationId, organizationId));
  const counts: Record<string, number> = {};
  for (const { status } of rows) counts[status] = (counts[status] ?? 0) + 1;
  return counts;
}
