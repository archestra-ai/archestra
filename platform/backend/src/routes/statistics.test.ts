import { vi } from "vitest";
import { hasAnyAgentTypeAdminPermission, hasPermission } from "@/auth";
import { getPermissionsForUserContext, userHasPermission } from "@/auth/utils";
import db, { schema } from "@/database";
import { SkillModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");
// `app:admin` and the skills admin gate are resolved through this module
// directly, so it is mocked alongside @/auth (module mocks match specifiers).
vi.mock("@/auth/utils");

describe("GET /api/statistics/users", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;

  /** Grants or denies `member:read`, which decides self-scoping. */
  const setCanReadAllUsers = (success: boolean) => {
    vi.mocked(hasPermission).mockResolvedValue({
      success,
    } as Awaited<ReturnType<typeof hasPermission>>);
  };

  beforeEach(async ({ makeAdmin, makeOrganization }) => {
    currentUser = await makeAdmin();
    const organization = await makeOrganization();
    organizationId = organization.id;

    vi.mocked(hasAnyAgentTypeAdminPermission).mockResolvedValue(true);
    setCanReadAllUsers(true);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = currentUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: statisticsRoutes } = await import("./statistics");
    await app.register(statisticsRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("returns per-user usage with the email needed to join an external roster", async ({
    makeAgent,
    makeInteraction,
    makeUser,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: currentUser.id });
    const someone = await makeUser({ email: "someone@test.com" });

    await makeInteraction(agent.id, {
      userId: someone.id,
      inputTokens: 80,
      outputTokens: 20,
      cost: "3.0000000000",
      model: "gpt-4o",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/statistics/users?timeframe=24h",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      userId: someone.id,
      userEmail: "someone@test.com",
      requests: 1,
      totalTokens: 100,
    });
    expect(body.pagination.total).toBe(1);
    // Opt-in enrichments stay off unless requested.
    expect(body.data[0].models).toBeUndefined();
  });

  test("includes the per-model breakdown when asked", async ({
    makeAgent,
    makeInteraction,
    makeUser,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: currentUser.id });
    const someone = await makeUser();

    await makeInteraction(agent.id, {
      userId: someone.id,
      inputTokens: 10,
      outputTokens: 10,
      model: "gpt-4o",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/statistics/users?timeframe=24h&includeModels=true",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data[0].models).toEqual([
      expect.objectContaining({ model: "gpt-4o", requests: 1 }),
    ]);
  });

  test("does not treat an explicit includeModels=false as truthy", async ({
    makeAgent,
    makeInteraction,
    makeUser,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: currentUser.id });
    const someone = await makeUser();

    await makeInteraction(agent.id, {
      userId: someone.id,
      inputTokens: 10,
      outputTokens: 10,
      model: "gpt-4o",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/statistics/users?timeframe=24h&includeModels=false",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data[0].models).toBeUndefined();
  });

  test("shows a caller without member:read only their own usage", async ({
    makeAgent,
    makeInteraction,
    makeUser,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: currentUser.id });
    const colleague = await makeUser();

    await makeInteraction(agent.id, {
      userId: currentUser.id,
      inputTokens: 5,
      outputTokens: 5,
      model: "gpt-4o",
    });
    await makeInteraction(agent.id, {
      userId: colleague.id,
      inputTokens: 900,
      outputTokens: 900,
      model: "gpt-4o",
    });

    setCanReadAllUsers(false);

    const response = await app.inject({
      method: "GET",
      url: "/api/statistics/users?timeframe=24h",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].userId).toBe(currentUser.id);
  });

  test("rejects a custom timeframe whose bounds are not dates", async () => {
    // A `custom:` value with unparseable bounds contributes no date predicate
    // to the query, so accepting it would silently widen the request to every
    // interaction ever recorded instead of the range the caller asked for.
    const response = await app.inject({
      method: "GET",
      url: "/api/statistics/users?timeframe=custom:not-a-date_also-not-a-date",
    });

    expect(response.statusCode).toBe(400);
  });

  test("rejects a custom timeframe that ends before it starts", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/statistics/users?timeframe=custom:2026-07-31T00:00:00.000Z_2026-07-01T00:00:00.000Z",
    });

    expect(response.statusCode).toBe(400);
  });

  test("accepts a well-formed custom timeframe", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/statistics/users?timeframe=custom:2026-07-01T00:00:00.000Z_2026-07-31T23:59:59.999Z",
    });

    expect(response.statusCode).toBe(200);
  });
});

describe("GET /api/statistics/apps", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeOrganization }) => {
    currentUser = await makeAdmin();
    const organization = await makeOrganization();
    organizationId = organization.id;

    vi.mocked(hasAnyAgentTypeAdminPermission).mockResolvedValue(true);
    vi.mocked(hasPermission).mockResolvedValue({ success: true } as Awaited<
      ReturnType<typeof hasPermission>
    >);
    // `app:admin` oversight, so the route reports on every app in the org.
    vi.mocked(userHasPermission).mockResolvedValue(true);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = currentUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: statisticsRoutes } = await import("./statistics");
    await app.register(statisticsRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("splits build and runtime spend, with the chat baseline behind the estimate", async ({
    makeAgent,
    makeApp,
    makeInteraction,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: currentUser.id });
    const built = await makeApp({
      organizationId,
      name: "Weekly Report",
      authoringSessionId: "authoring-session",
    });

    await makeInteraction(agent.id, {
      sessionId: "authoring-session",
      source: "chat",
      cost: "0.5000000000",
    });
    await makeInteraction(agent.id, {
      appId: built.id,
      source: "app:llm_complete",
      cost: "0.0200000000",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/statistics/apps?timeframe=24h",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const row = body.data.find(
      (entry: { appId: string }) => entry.appId === built.id,
    );
    expect(row).toMatchObject({
      appName: "Weekly Report",
      buildRequests: 1,
      runtimeLlmRequests: 1,
      hasBuildSession: true,
    });
    expect(row.buildCost).toBeCloseTo(0.5, 10);
    expect(row.runtimeCost).toBeCloseTo(0.02, 10);
    // The counterfactual's multiplier travels with the page so it can be judged.
    expect(body).toHaveProperty("chatBaselineCostPerSession");
    expect(body).toHaveProperty("chatBaselineSessions");
  });

  test("omits apps the caller cannot see", async ({ makeApp, makeUser }) => {
    // No app:admin, so only the caller's own personal app is in scope.
    vi.mocked(userHasPermission).mockResolvedValue(false);
    const someoneElse = await makeUser();
    const mine = await makeApp({
      organizationId,
      name: "Mine",
      authorId: currentUser.id,
      scope: "personal",
    });
    const theirs = await makeApp({
      organizationId,
      name: "Theirs",
      authorId: someoneElse.id,
      scope: "personal",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/statistics/apps?timeframe=24h",
    });

    expect(response.statusCode).toBe(200);
    const appIds = response
      .json()
      .data.map((entry: { appId: string }) => entry.appId);
    expect(appIds).toContain(mine.id);
    expect(appIds).not.toContain(theirs.id);
  });
});

describe("GET /api/statistics/skills", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;

  beforeEach(async ({ makeAdmin, makeOrganization }) => {
    currentUser = await makeAdmin();
    const organization = await makeOrganization();
    organizationId = organization.id;

    vi.mocked(hasAnyAgentTypeAdminPermission).mockResolvedValue(true);
    vi.mocked(hasPermission).mockResolvedValue({ success: true } as Awaited<
      ReturnType<typeof hasPermission>
    >);
    vi.mocked(userHasPermission).mockResolvedValue(true);
    // `skill:admin` oversight, so the route reports on every skill in the org.
    vi.mocked(getPermissionsForUserContext).mockResolvedValue({
      skill: ["read", "admin"],
    } as Awaited<ReturnType<typeof getPermissionsForUserContext>>);

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = currentUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: statisticsRoutes } = await import("./statistics");
    await app.register(statisticsRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("reports the skill's own context footprint alongside the spend it rode", async ({
    makeAgent,
    makeInteraction,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: currentUser.id });
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId,
        authorId: null,
        name: "Reporting",
        description: "desc",
        content: "# body",
        metadata: {},
        sourceType: "manual",
        scope: "org",
      },
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    const activatedAt = new Date(Date.now() - 60_000);
    await db.insert(schema.skillUsageEventsTable).values({
      skillId: skill.id,
      userId: currentUser.id,
      sessionId: "skill-session",
      contextTokens: 900,
      createdAt: activatedAt,
    });
    await makeInteraction(agent.id, {
      sessionId: "skill-session",
      source: "chat",
      cost: "0.2500000000",
      createdAt: new Date(Date.now() - 30_000),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/statistics/skills?timeframe=24h",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      skillId: skill.id,
      skillName: "Reporting",
      activations: 1,
      contextTokens: 900,
      measuredActivations: 1,
      attributedSessions: 1,
      attributedRequests: 1,
    });
    expect(body.data[0].attributedCost).toBeCloseTo(0.25, 10);
  });
});

describe("GET /api/statistics/me", () => {
  let app: FastifyInstanceWithZod;
  let currentUser: User;
  let organizationId: string;

  beforeEach(async ({ makeUser, makeOrganization }) => {
    currentUser = await makeUser({ email: "me@test.com" });
    const organization = await makeOrganization();
    organizationId = organization.id;

    // The caller is deliberately given nothing: this endpoint is the one
    // statistics view that must work without cost or roster permissions.
    vi.mocked(hasAnyAgentTypeAdminPermission).mockResolvedValue(false);
    vi.mocked(hasPermission).mockResolvedValue({
      success: false,
    } as Awaited<ReturnType<typeof hasPermission>>);
    vi.mocked(userHasPermission).mockResolvedValue(false);
    vi.mocked(getPermissionsForUserContext).mockResolvedValue({});

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = currentUser;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: statisticsRoutes } = await import("./statistics");
    await app.register(statisticsRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("reports the caller's own usage, keeping billed spend and subscription-covered usage apart", async ({
    makeAgent,
    makeInteraction,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: currentUser.id });

    await makeInteraction(agent.id, {
      userId: currentUser.id,
      inputTokens: 80,
      outputTokens: 20,
      cacheReadTokens: 10,
      cost: "3.0000000000",
      model: "gpt-4o",
      billingMode: "metered",
    });
    await makeInteraction(agent.id, {
      userId: currentUser.id,
      inputTokens: 400,
      outputTokens: 100,
      cost: "9.0000000000",
      model: "claude-opus-4",
      billingMode: "subscription",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/statistics/me?timeframe=24h",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      requests: 2,
      inputTokens: 480,
      outputTokens: 120,
      cacheReadTokens: 10,
      totalTokens: 600,
      activeDays: 1,
    });
    // Subscription traffic is not spend: it is reported at list price, apart
    // from the $3 actually billed.
    expect(body.billedCost).toBeCloseTo(3, 10);
    expect(body.subscriptionCost).toBeCloseTo(9, 10);
    expect(body.lastActiveAt).not.toBeNull();
    // Model mix comes back heaviest first.
    expect(body.models.map((model: { model: string }) => model.model)).toEqual([
      "claude-opus-4",
      "gpt-4o",
    ]);
    expect(body.timeSeries.length).toBeGreaterThan(0);
  });

  test("never reports anyone else's usage", async ({
    makeAgent,
    makeInteraction,
    makeUser,
  }) => {
    const agent = await makeAgent({ organizationId, authorId: currentUser.id });
    const someoneElse = await makeUser({ email: "someone-else@test.com" });

    await makeInteraction(agent.id, {
      userId: someoneElse.id,
      inputTokens: 5_000,
      outputTokens: 5_000,
      cost: "50.0000000000",
      model: "gpt-4o",
    });
    await makeInteraction(agent.id, {
      userId: currentUser.id,
      inputTokens: 10,
      outputTokens: 10,
      cost: "1.0000000000",
      model: "gpt-4o",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/statistics/me?timeframe=24h",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.requests).toBe(1);
    expect(body.totalTokens).toBe(20);
    expect(body.billedCost).toBeCloseTo(1, 10);
    expect(JSON.stringify(body)).not.toContain(someoneElse.id);
  });

  test("counts the caller's own usage on agents they cannot access", async ({
    makeAgent,
    makeInteraction,
    makeUser,
  }) => {
    // An agent owned by someone else, which this caller has no access to: their
    // own spend on it is still their own spend and must not go missing.
    const otherAuthor = await makeUser({ email: "author@test.com" });
    const agent = await makeAgent({
      organizationId,
      authorId: otherAuthor.id,
    });

    await makeInteraction(agent.id, {
      userId: currentUser.id,
      inputTokens: 30,
      outputTokens: 70,
      cost: "2.0000000000",
      model: "gpt-4o",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/statistics/me?timeframe=24h",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ requests: 1, totalTokens: 100 });
  });

  test("excludes the caller's usage in another organization", async ({
    makeAgent,
    makeInteraction,
    makeOrganization,
  }) => {
    const otherOrganization = await makeOrganization({ slug: "other-org" });
    const otherOrgAgent = await makeAgent({
      organizationId: otherOrganization.id,
      authorId: currentUser.id,
    });

    await makeInteraction(otherOrgAgent.id, {
      userId: currentUser.id,
      inputTokens: 1_000,
      outputTokens: 1_000,
      cost: "7.0000000000",
      model: "gpt-4o",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/statistics/me?timeframe=24h",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      requests: 0,
      totalTokens: 0,
      billedCost: 0,
      activeDays: 0,
      lastActiveAt: null,
      models: [],
    });
  });

  test("returns zeros rather than failing when the caller has no activity", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/statistics/me?timeframe=24h",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      billedCost: 0,
      subscriptionCost: 0,
      activeDays: 0,
      lastActiveAt: null,
      models: [],
      timeSeries: [],
    });
  });
});
