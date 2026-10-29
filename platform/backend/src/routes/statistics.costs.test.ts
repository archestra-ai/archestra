import { vi } from "vitest";
import { betterAuth } from "@/auth";
import { authPlugin } from "@/auth/fastify-plugin";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { MemberModel, StatisticsModel } from "@/models";
import { afterEach, beforeEach, expect, test } from "@/test";
import { recordQueries } from "@/test/query-counter";
import type { User } from "@/types";

let app: FastifyInstanceWithZod;
let organizationId: string;
let user: User;
beforeEach(async ({ makeOrganization, makeUser, makeMember, makeSession }) => {
  organizationId = (await makeOrganization()).id;
  app = createFastifyInstance();
  user = await makeUser();
  await makeMember(user.id, organizationId, { role: "admin" });
  const session = await makeSession(user.id, {
    activeOrganizationId: organizationId,
  });
  vi.spyOn(betterAuth.api, "getSession").mockResolvedValue({
    response: { user, session },
    headers: new Headers(),
  } as never);
  await app.register(authPlugin);
  await app.register((await import("./statistics")).default);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
});

test("shares the cost/model scan, reconciles legacy totals, and isolates mixed ownership", async ({
  makeAgent,
  makeInteraction,
  makeUser,
  makeOrganization,
  makeApp,
}) => {
  const agent = await makeAgent({ organizationId });
  const otherOrg = (await makeOrganization()).id;
  const foreignAgent = await makeAgent({ organizationId: otherOrg });
  const foreignApp = await makeApp({ organizationId: otherOrg });
  const someone = await makeUser();
  for (const [model, userId, billingMode, cost, hour] of [
    ["example-a", user.id, "metered", "2", 1],
    ["example-b", user.id, "subscription", "7", 2],
    ["example-a", someone.id, "metered", "3", 3],
  ] as const) {
    await makeInteraction(agent.id, {
      model,
      userId,
      billingMode,
      cost,
      baselineCost: cost,
      cacheSavings: "0.5",
      inputTokens: 1_500_000_000,
      outputTokens: 10,
      cacheReadTokens: 20,
      createdAt: new Date(`2026-08-01T0${hour}:00:00Z`),
    });
  }
  await makeInteraction(foreignAgent.id, {
    userId: someone.id,
    cost: "99",
    createdAt: new Date("2026-08-01T01:00:00Z"),
  });
  await makeInteraction(agent.id, {
    appId: foreignApp.id,
    userId: someone.id,
    cost: "99",
    createdAt: new Date("2026-08-01T01:00:00Z"),
  });
  await makeInteraction(agent.id, {
    userId: someone.id,
    cost: "99",
    createdAt: new Date("2026-07-01T01:00:00Z"),
  });
  const timeframe = "custom:2026-08-01T00:00:00Z_2026-08-02T00:00:00Z";
  const response = await app.inject({
    url: `/api/statistics/costs?timeframe=${encodeURIComponent(timeframe)}`,
  });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.activeUsers).toBe(2);
  expect(body.costSavings).toMatchObject({
    totalActualCost: 5,
    totalSubscriptionCost: 7,
    totalCacheSavings: 1,
  });
  expect(body.costSavings).toEqual(
    await StatisticsModel.getCostSavingsStatistics({
      timeframe,
      organizationId,
    }),
  );
  expect(body.models).toEqual(
    await StatisticsModel.getModelStatistics({ timeframe, organizationId }),
  );
  expect(
    body.models.reduce(
      (total: number, model: { requests: number }) => total + model.requests,
      0,
    ),
  ).toBe(3);
  expect(
    body.models.reduce(
      (total: number, model: { inputTokens: number }) =>
        total + model.inputTokens,
      0,
    ),
  ).toBe(4_500_000_000);
  expect(response.body).not.toContain(someone.email);
  const { statements } = await recordQueries(() =>
    StatisticsModel.getCostStatistics({
      timeframe,
      organizationId,
      requestingUserId: user.id,
      canReadAllUsers: true,
    }),
  );
  expect(
    statements.filter((statement) => statement.includes('from "interactions"')),
  ).toHaveLength(2);
});

test("counts distinct active users beyond a roster page and self-scopes without member:read", async ({
  makeAgent,
  makeInteraction,
  makeUser,
  makeCustomRole,
}) => {
  const agent = await makeAgent({ organizationId });
  await makeInteraction(agent.id, { userId: user.id });
  const people = await Promise.all(
    Array.from({ length: 51 }, () => makeUser()),
  );
  await Promise.all(
    people.map((person) => makeInteraction(agent.id, { userId: person.id })),
  );
  await makeInteraction(agent.id, { userId: user.id });
  expect(
    (await app.inject({ url: "/api/statistics/costs" })).json().activeUsers,
  ).toBe(52);
  const role = await makeCustomRole(organizationId, {
    permission: { llmCost: ["read"] },
  });
  await MemberModel.updateRole(user.id, organizationId, role.role);
  const response = await app.inject({ url: "/api/statistics/costs" });
  expect(response.statusCode).toBe(200);
  expect(response.json().activeUsers).toBe(1);
});

test("rejects missing cost permissions and invalid ranges, and returns an empty overview", async () => {
  expect(
    (
      await app.inject({
        url: "/api/statistics/costs?timeframe=custom:invalid_invalid",
      })
    ).statusCode,
  ).toBe(400);
  const response = await app.inject({ url: "/api/statistics/costs" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    activeUsers: 0,
    models: [],
    costSavings: {
      totalActualCost: 0,
      totalSubscriptionCost: 0,
      timeSeries: [],
    },
  });
  await MemberModel.updateRole(user.id, organizationId, "member");
  expect((await app.inject({ url: "/api/statistics/costs" })).statusCode).toBe(
    403,
  );
});

for (const timeframe of ["5m", "7d", "30d", "90d", "all"] as const) {
  test(`preserves costs and model buckets for ${timeframe}, including unattributed usage`, async ({
    makeAgent,
    makeInteraction,
  }) => {
    const agent = await makeAgent({ organizationId });
    const now = Date.now();
    for (const [model, billingMode, cost, age] of [
      ["example", "metered", "0.3", 0],
      ["example", "subscription", "0.7", 120_000],
      [null, "metered", "1", 60_000],
      ["example", "metered", "0.5", 86_400_000],
    ] as const) {
      await makeInteraction(agent.id, {
        model,
        billingMode,
        cost,
        baselineCost: cost,
        cacheSavings: "0.1",
        createdAt: new Date(now - age),
      });
    }
    const result = await StatisticsModel.getCostStatistics({
      timeframe,
      organizationId,
      requestingUserId: user.id,
      canReadAllUsers: true,
    });
    const legacyCosts = await StatisticsModel.getCostSavingsStatistics({
      timeframe,
      organizationId,
    });
    expect(result.costSavings.totalActualCost).toBeCloseTo(
      legacyCosts.totalActualCost,
      10,
    );
    expect(result.costSavings.totalSubscriptionCost).toBeCloseTo(
      legacyCosts.totalSubscriptionCost,
      10,
    );
    expect(
      result.costSavings.timeSeries.map((point) => point.timestamp),
    ).toEqual(legacyCosts.timeSeries.map((point) => point.timestamp));
    for (const [index, point] of result.costSavings.timeSeries.entries()) {
      // Grouping by model changes floating-point addition order; compare well
      // below the precision at which costs are displayed.
      for (const field of [
        "actualCost",
        "baselineCost",
        "cacheSavings",
        "subscriptionCost",
      ] as const) {
        expect(point[field]).toBeCloseTo(
          legacyCosts.timeSeries[index][field],
          10,
        );
      }
    }
    expect(result.models).toEqual(
      await StatisticsModel.getModelStatistics({ timeframe, organizationId }),
    );
    expect(result.activeUsers).toBe(0);
  });
}
