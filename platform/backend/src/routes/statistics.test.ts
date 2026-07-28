import { vi } from "vitest";
import { hasAnyAgentTypeAdminPermission, hasPermission } from "@/auth";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/auth");

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
});
