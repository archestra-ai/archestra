import { vi } from "vitest";
import { betterAuth } from "@/auth";
import { authPlugin } from "@/auth/fastify-plugin";
import db, { schema } from "@/database";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import MemberModel from "@/models/member";
import { afterEach, beforeEach, expect, test } from "@/test";
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

test("keeps the selected model across people, keys and agents with matching timelines and unknown identities", async ({
  makeAgent,
  makeInteraction,
  makeUser,
  makeVirtualApiKey,
  makeOrganization,
}) => {
  const agent = await makeAgent({ organizationId, name: "Research agent" });
  const proxy = await makeAgent({ organizationId, agentType: "llm_proxy" });
  const key = await makeVirtualApiKey(organizationId, {
    name: "Analytics key",
  });
  const otherUser = await makeUser();
  await makeInteraction(agent.id, {
    model: "example/model+a",
    userId: user.id,
    inputTokens: 100,
    outputTokens: 10,
    cost: "3",
  });
  await makeInteraction(proxy.id, {
    model: "example/model+a",
    userId: otherUser.id,
    authMethod: "virtual_key",
    virtualKeyId: key.id,
    cost: "2",
  });
  await makeInteraction(proxy.id, {
    model: "example/model+a",
    billingMode: "subscription",
    cost: "7",
  });
  await makeInteraction(agent.id, {
    model: "example/model-b",
    userId: user.id,
    cost: "99",
  });
  await makeInteraction(agent.id, {
    model: "example/model+a",
    userId: user.id,
    cost: "999",
    createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
  });
  const foreign = await makeAgent({
    organizationId: (await makeOrganization()).id,
  });
  await makeInteraction(foreign.id, {
    model: "example/model+a",
    userId: user.id,
    cost: "200",
  });
  for (const groupBy of ["person", "key", "agent"]) {
    const response = await app.inject({
      url: `/api/statistics/model-usage?model=example%2Fmodel%2Ba&groupBy=${groupBy}&timeframe=24h`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const rows = response.json().data;
    expect(
      rows.reduce(
        (sum: number, row: { billedCost: number }) => sum + row.billedCost,
        0,
      ),
    ).toBe(5);
    expect(
      rows.reduce(
        (sum: number, row: { subscriptionCost: number }) =>
          sum + row.subscriptionCost,
        0,
      ),
    ).toBe(7);
    for (const row of rows)
      expect(
        row.timeSeries.reduce(
          (sum: number, point: { billedCost: number }) =>
            sum + point.billedCost,
          0,
        ),
      ).toBe(row.billedCost);
    if (groupBy === "key")
      expect(
        rows.some((row: { name: string }) => row.name === "Analytics key"),
      ).toBe(true);
    if (groupBy === "agent")
      expect(
        rows.some((row: { name: string }) => row.name === "Research agent"),
      ).toBe(true);
    if (groupBy === "person")
      expect(
        rows.some((row: { id: string }) => row.id === "__unattributed__"),
      ).toBe(true);
  }
  const page = await app.inject({
    url: "/api/statistics/model-usage?model=example%2Fmodel%2Ba&groupBy=person&limit=1",
  });
  expect(page.json().pagination).toMatchObject({ total: 3, hasNext: true });
  const own = await app.inject({
    url: "/api/statistics/me/model-usage?model=example%2Fmodel%2Ba&groupBy=client",
  });
  expect(own.statusCode).toBe(200);
  expect(
    own
      .json()
      .data.reduce(
        (sum: number, row: { billedCost: number }) => sum + row.billedCost,
        0,
      ),
  ).toBe(3);
});

test("rejects invalid personal dimensions and returns no rows for an unused model", async () => {
  expect(
    (
      await app.inject({
        url: "/api/statistics/me/model-usage?model=example&groupBy=person",
      })
    ).statusCode,
  ).toBe(400);
  const response = await app.inject({
    url: "/api/statistics/model-usage?model=unused&groupBy=agent",
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data).toEqual([]);
});

test("requires cost permission for organization usage and never widens a caller-only report", async ({
  makeAgent,
  makeInteraction,
  makeUser,
  makeCustomRole,
}) => {
  const agent = await makeAgent({ organizationId });
  const other = await makeUser();
  await makeInteraction(agent.id, {
    model: "example",
    userId: user.id,
    cost: "2",
  });
  await makeInteraction(agent.id, {
    model: "example",
    userId: other.id,
    cost: "50",
  });
  const role = await makeCustomRole(organizationId, {
    permission: { llmCost: ["read"] },
  });
  await MemberModel.updateRole(user.id, organizationId, role.role);
  const people = await app.inject({
    url: "/api/statistics/model-usage?model=example&groupBy=person",
  });
  expect(people.statusCode, people.body).toBe(200);
  expect(people.json().data).toHaveLength(1);
  expect(people.json().data[0]).toMatchObject({ id: user.id, billedCost: 2 });
  await MemberModel.updateRole(user.id, organizationId, "member");
  expect(
    (await app.inject({ url: "/api/statistics/model-usage?model=example" }))
      .statusCode,
  ).toBe(403);
  const own = await app.inject({
    url: "/api/statistics/me/model-usage?model=example",
  });
  expect(own.statusCode).toBe(200);
  expect(own.json().data[0].billedCost).toBe(2);
});

test("allocates multi-model billing receipts to only the selected model's component", async ({
  makeAgent,
  makeInteraction,
}) => {
  const agent = await makeAgent({ organizationId });
  const interaction = await makeInteraction(agent.id, {
    model: "message-model",
    userId: user.id,
    cost: "9",
    inputTokens: 900,
  });
  const component = (
    model: string,
    kind: "message" | "advisor_message",
    cost: string,
    inputTokens: number,
  ) => ({
    id: model,
    model,
    kind,
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    provider: "openai" as const,
    prices: {
      input: "1",
      output: "1",
      cacheRead: null,
      cacheWrite: null,
      cacheWrite1h: null,
      source: "test",
    },
    cost,
  });
  await db.insert(schema.interactionBillingTable).values({
    interactionId: interaction.id,
    organizationId,
    billingMode: "metered",
    fingerprint: "test-model-receipt",
    usage: {
      version: 1,
      mode: "enforce",
      status: "complete",
      issues: [],
      cost: "9",
      components: [
        component("message-model", "message", "7", 700),
        component("advisor-model", "advisor_message", "2", 200),
      ],
    },
  });
  const response = await app.inject({
    url: "/api/statistics/model-usage?model=advisor-model&groupBy=person",
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().data[0]).toMatchObject({
    id: user.id,
    billedCost: 2,
    totalTokens: 200,
    requests: 0,
  });
});
