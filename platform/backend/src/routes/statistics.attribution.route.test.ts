import { describe, expect, test } from "@/test";
import { useRouteTestApp } from "@/test/route-test-app";
import statisticsRoutes from "./statistics";

describe("proxy label cost attribution", () => {
  const ctx = useRouteTestApp(statisticsRoutes);
  test("discovers distinct captured label keys within the organization and time range", async ({
    makeAgent,
    makeInteraction,
    makeOrganization,
  }) => {
    const proxy = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "llm_proxy",
    });
    const foreign = await makeOrganization();
    const otherProxy = await makeAgent({
      organizationId: foreign.id,
      agentType: "llm_proxy",
    });
    await makeInteraction(proxy.id, {
      attributionLabels: { cost_center: "C100", application: "search" },
    });
    await makeInteraction(proxy.id, {
      attributionLabels: { cost_center: "C200" },
    });
    await makeInteraction(proxy.id, { attributionLabels: null });
    await makeInteraction(proxy.id, {
      attributionLabels: { old_key: "old" },
      createdAt: new Date("2020-01-01"),
    });
    await makeInteraction(otherProxy.id, {
      attributionLabels: { private_key: "foreign" },
    });
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/statistics/llm-proxy?timeframe=24h&includeLabelKeys=true&limit=1",
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().labelKeys).toEqual(["application", "cost_center"]);
    expect(response.json().totals.requests).toBe(3);
  });

  test("label groups reconcile to totals, include unassigned history, and preserve billing modes and organization scope", async ({
    makeAgent,
    makeInteraction,
    makeOrganization,
  }) => {
    const proxy = await makeAgent({
      organizationId: ctx.organizationId,
      agentType: "llm_proxy",
    });
    const foreign = await makeOrganization();
    const foreignProxy = await makeAgent({
      organizationId: foreign.id,
      agentType: "llm_proxy",
    });
    const examples: Parameters<typeof makeInteraction>[1][] = [
      { attributionLabels: { cost_center: "C100", app: "search" }, cost: "2" },
      { attributionLabels: { cost_center: "C100", app: "batch" }, cost: "3" },
      {
        attributionLabels: { cost_center: "C100" },
        cost: "7",
        billingMode: "subscription" as const,
      },
      { attributionLabels: { cost_center: "C200" }, cost: "4" },
      { attributionLabels: null, cost: "9" },
    ];
    for (const row of examples) await makeInteraction(proxy.id, row);
    await makeInteraction(foreignProxy.id, {
      attributionLabels: { cost_center: "C100" },
      cost: "100",
    });
    const response = await ctx.app.inject({
      method: "GET",
      url: "/api/statistics/llm-proxy?timeframe=24h&labelKey=cost_center",
    });
    expect(response.statusCode, response.body).toBe(200);
    const data = response.json();
    expect(data.totals).toMatchObject({
      requests: 5,
      billedCost: 18,
      subscriptionCost: 7,
    });
    expect(data.labels.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: "C100",
          requests: 3,
          billedCost: 5,
          subscriptionCost: 7,
        }),
        expect.objectContaining({ value: "C200", requests: 1, billedCost: 4 }),
        expect.objectContaining({ value: null, requests: 1, billedCost: 9 }),
      ]),
    );
    expect(
      data.labels.groups.reduce(
        (sum: number, row: { billedCost: number }) => sum + row.billedCost,
        0,
      ),
    ).toBe(data.totals.billedCost);
    for (const offset of [0, 1, 2, 3]) {
      const page = await ctx.app.inject({
        method: "GET",
        url: `/api/statistics/llm-proxy?timeframe=24h&labelKey=cost_center&limit=1&offset=${offset}`,
      });
      expect(page.json().labels.pagination.total).toBe(3);
      expect(page.json().labels.groups).toHaveLength(offset === 3 ? 0 : 1);
      expect(page.json().totals.billedCost).toBe(18);
    }
    const filtered = await ctx.app.inject({
      method: "GET",
      url: "/api/statistics/llm-proxy?labelKey=cost_center&labelValue=C100",
    });
    expect(filtered.json().totals).toMatchObject({
      requests: 3,
      billedCost: 5,
    });
    const unassigned = await ctx.app.inject({
      method: "GET",
      url: "/api/statistics/llm-proxy?labelKey=cost_center&labelUnassigned=true",
    });
    expect(unassigned.json().totals).toMatchObject({
      requests: 1,
      billedCost: 9,
    });
    const quoted = await ctx.app.inject({
      method: "GET",
      url: `/api/statistics/llm-proxy?${new URLSearchParams({ labelKey: "cost_center", labelValue: "C100' OR '1'='1" })}`,
    });
    expect(quoted.statusCode).toBe(200);
    expect(quoted.json().totals.requests).toBe(0);
  });

  test("rejects incomplete or contradictory label filters", async () => {
    for (const query of [
      "labelValue=C100",
      "labelUnassigned=true",
      "labelKey=cost_center&labelValue=C100&labelUnassigned=true",
    ]) {
      const response = await ctx.app.inject({
        method: "GET",
        url: `/api/statistics/llm-proxy?${query}`,
      });
      expect(response.statusCode).toBe(400);
    }
  });
});
