import { vi } from "vitest";
import { betterAuth, hasPermission } from "@/auth";
import { authPlugin } from "@/auth/fastify-plugin";
import { AgentTeamModel } from "@/models";

vi.mock("@/auth");

import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import { afterEach, beforeEach, expect, test } from "@/test";

let app: FastifyInstanceWithZod;
let organizationId: string;
beforeEach(async ({ makeOrganization, makeUser, makeMember, makeSession }) => {
  organizationId = (await makeOrganization()).id;
  app = createFastifyInstance();
  const user = await makeUser();
  await makeMember(user.id, organizationId, { role: "admin" });
  const session = await makeSession(user.id, {
    activeOrganizationId: organizationId,
  });
  vi.mocked(betterAuth.api.getSession).mockResolvedValue({
    response: { user, session },
    headers: new Headers(),
  } as never);
  vi.mocked(hasPermission).mockResolvedValue({ success: true, error: null });
  await app.register(authPlugin);
  await app.register((await import("./statistics")).default);
});
afterEach(async () => {
  await app.close();
});

test("counts each primary credential once and separates subscription coverage across access methods", async ({
  makeAgent,
  makeInteraction,
  makeVirtualApiKey,
  makeTeam,
  makeUser,
}) => {
  const proxy = await makeAgent({ organizationId, agentType: "llm_proxy" });
  const owner = await makeUser();
  const teamA = await makeTeam(organizationId, owner.id);
  const teamB = await makeTeam(organizationId, owner.id);
  await AgentTeamModel.assignTeamsToAgent(proxy.id, [teamA.id, teamB.id]);
  const standard = await makeVirtualApiKey(organizationId, {
    name: "Build pipeline",
  });
  const secondary = await makeVirtualApiKey(organizationId, {
    name: "Developer identity",
  });
  await makeInteraction(proxy.id, {
    authMethod: "virtual_key",
    virtualKeyId: standard.id,
    passthroughVirtualKeyId: secondary.id,
    cost: "3",
    inputTokens: 1_500_000_000,
    outputTokens: 5,
  });
  await makeInteraction(proxy.id, {
    authMethod: "virtual_key",
    virtualKeyId: standard.id,
    billingMode: "subscription",
    cost: "7",
    inputTokens: 1_500_000_000,
    outputTokens: 5,
  });
  await makeInteraction(proxy.id, {
    authMethod: "oauth_client_credentials",
    authenticatedAppId: "build-app",
    authenticatedAppName: "Build application",
    cost: "2",
  });
  await makeInteraction(proxy.id, { authMethod: "oauth_user", cost: "1" });
  await makeInteraction(proxy.id, {
    authMethod: "passthrough_virtual_key",
    passthroughVirtualKeyId: secondary.id,
    cost: "4",
  });
  await makeInteraction(proxy.id, { authMethod: null, cost: "0.5" });
  await makeInteraction(proxy.id, {
    authMethod: "virtual_key",
    virtualKeyId: null,
    cost: "0.25",
  });
  const response = await app.inject({
    url: "/api/statistics/llm-proxy?timeframe=24h&limit=1",
  });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.totals).toMatchObject({
    requests: 7,
    billedCost: 10.75,
    subscriptionCost: 7,
  });
  expect(body.pagination.total).toBe(6);
  expect(body.credentials).toHaveLength(1);
  expect(
    body.timeSeries.reduce(
      (sum: number, point: { billedCost: number }) => sum + point.billedCost,
      0,
    ),
  ).toBe(10.75);
  expect(
    body.methods.find(
      (row: { authMethod: string }) => row.authMethod === "virtual_key",
    ),
  ).toMatchObject({ requests: 3, billedCost: 3.25, subscriptionCost: 7 });
  const focused = await app.inject({
    url: `/api/statistics/llm-proxy?authMethod=virtual_key&credentialId=${standard.id}`,
  });
  expect(focused.json().totals).toMatchObject({
    requests: 2,
    billedCost: 3,
    subscriptionCost: 7,
    inputTokens: 3_000_000_000,
  });
  expect(focused.json().credentials[0]).toMatchObject({
    credentialId: standard.id,
    credentialName: "Build pipeline",
  });
  const missingPage = await app.inject({
    url: "/api/statistics/llm-proxy?offset=100",
  });
  expect(missingPage.json()).toMatchObject({
    credentials: [],
    pagination: { total: 6 },
    totals: { requests: 7 },
  });
});

test("includes legacy and soft-deleted proxy traffic but excludes chat, other organizations and out-of-range requests", async ({
  makeAgent,
  makeInteraction,
  makeOrganization,
}) => {
  const legacy = await makeAgent({
    organizationId,
    agentType: "profile",
    deletedAt: new Date(),
  });
  const chat = await makeAgent({ organizationId, agentType: "agent" });
  const other = await makeAgent({
    organizationId: (await makeOrganization()).id,
    agentType: "llm_proxy",
  });
  const timestamp = new Date("2026-08-01T12:00:00Z");
  await makeInteraction(legacy.id, {
    cost: "2",
    createdAt: timestamp,
    authMethod: "provider_key",
  });
  await makeInteraction(legacy.id, {
    cost: "99",
    createdAt: new Date("2026-07-01T00:00:00Z"),
  });
  await makeInteraction(chat.id, { cost: "99", createdAt: timestamp });
  await makeInteraction(other.id, { cost: "99", createdAt: timestamp });
  const timeframe = encodeURIComponent(
    "custom:2026-08-01T00:00:00Z_2026-08-02T00:00:00Z",
  );
  const response = await app.inject({
    url: `/api/statistics/llm-proxy?timeframe=${timeframe}`,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().totals).toMatchObject({ requests: 1, billedCost: 2 });
  expect(response.json().timeSeries[0].timestamp).toBe(
    "2026-08-01T12:00:00.000Z",
  );
});

test("validates filters and distinguishes empty results from errors", async () => {
  expect(
    (await app.inject({ url: "/api/statistics/llm-proxy?authMethod=made_up" }))
      .statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        url: "/api/statistics/llm-proxy?timeframe=custom:invalid_invalid",
      })
    ).statusCode,
  ).toBe(400);
  const response = await app.inject({ url: "/api/statistics/llm-proxy" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    totals: { requests: 0, billedCost: 0, subscriptionCost: 0 },
    credentials: [],
    methods: [],
    timeSeries: [],
  });
});

test("denies callers without organization cost access", async () => {
  vi.mocked(hasPermission).mockResolvedValue({ success: false, error: null });
  const response = await app.inject({ url: "/api/statistics/llm-proxy" });
  expect(response.statusCode).toBe(403);
});
