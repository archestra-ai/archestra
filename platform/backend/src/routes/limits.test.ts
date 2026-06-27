import { vi } from "vitest";
import { EnvironmentModel, LimitModel } from "@/models";
import AgentModel from "@/models/agent";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/observability", () => ({
  initializeObservabilityMetrics: vi.fn(),
  metrics: {
    llm: { initializeMetrics: vi.fn() },
    mcp: { initializeMcpMetrics: vi.fn() },
    agentExecution: { initializeAgentExecutionMetrics: vi.fn() },
  },
}));

describe("limits routes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let user: User;

  beforeEach(async ({ makeOrganization, makeAdmin }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeAdmin();

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (
        request as typeof request & {
          organizationId: string;
          user: User;
        }
      ).organizationId = organizationId;
      (request as typeof request & { user: User }).user = user;
    });

    const { default: limitsRoutes } = await import("./limits");
    await app.register(limitsRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  describe("GET /api/limits", () => {
    test("calls cleanupLimitsIfNeeded with allForOrganizationId before returning limits", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({
        name: "Test Agent",
        organizationId,
      });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["gpt-4o"],
      });

      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "gpt-4o",
        500,
        500,
      );

      const cleanupSpy = vi.spyOn(LimitModel, "cleanupLimitsIfNeeded");

      const response = await app.inject({
        method: "GET",
        url: "/api/limits",
      });

      expect(response.statusCode).toBe(200);
      expect(cleanupSpy).toHaveBeenCalledWith({
        allForOrganizationId: organizationId,
        entityType: undefined,
        entityId: undefined,
        limitType: undefined,
      });

      const body = response.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);

      const returnedLimit = body.find((l: { id: string }) => l.id === limit.id);
      expect(returnedLimit).toBeDefined();

      cleanupSpy.mockRestore();
    });

    test("cleanup resets usage before limits are returned", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const agent = await makeAgent({
        name: "Test Agent",
        organizationId,
      });
      const otherOrganization = await makeOrganization();
      const otherAgent = await makeAgent({
        name: "Other Org Agent",
        organizationId: otherOrganization.id,
      });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["gpt-4o"],
      });
      const otherLimit = await LimitModel.create({
        entityType: "agent",
        entityId: otherAgent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["gpt-4o"],
      });

      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "gpt-4o",
        500,
        500,
      );
      await LimitModel.updateTokenLimitUsage(
        "agent",
        otherAgent.id,
        "gpt-4o",
        700,
        700,
      );

      const response = await app.inject({
        method: "GET",
        url: "/api/limits",
      });

      expect(response.statusCode).toBe(200);

      const body = response.json();
      const returnedLimit = body.find((l: { id: string }) => l.id === limit.id);
      expect(returnedLimit).toBeDefined();
      expect(
        body.some(
          (candidate: { id: string }) => candidate.id === otherLimit.id,
        ),
      ).toBe(false);
      expect(returnedLimit.modelUsage).toBeDefined();

      const gpt4oUsage = returnedLimit.modelUsage.find(
        (u: { model: string }) => u.model === "gpt-4o",
      );
      expect(gpt4oUsage).toBeDefined();
      expect(gpt4oUsage.tokensIn).toBe(0);
      expect(gpt4oUsage.tokensOut).toBe(0);

      const otherModelUsage = await LimitModel.getRawModelUsage(otherLimit.id);
      expect(otherModelUsage[0].currentUsageTokensIn).toBe(700);
      expect(otherModelUsage[0].currentUsageTokensOut).toBe(700);
    });

    test("does not cleanup limits with recent lastCleanup", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({
        name: "Test Agent",
        organizationId,
      });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["gpt-4o"],
      });

      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "gpt-4o",
        500,
        500,
      );

      await LimitModel.patch(limit.id, { lastCleanup: new Date() });

      const response = await app.inject({
        method: "GET",
        url: "/api/limits",
      });

      expect(response.statusCode).toBe(200);

      const body = response.json();
      const returnedLimit = body.find((l: { id: string }) => l.id === limit.id);
      expect(returnedLimit).toBeDefined();

      const gpt4oUsage = returnedLimit.modelUsage.find(
        (u: { model: string }) => u.model === "gpt-4o",
      );
      expect(gpt4oUsage.tokensIn).toBe(500);
      expect(gpt4oUsage.tokensOut).toBe(500);
    });

    test("cleanup with allForOrganizationId handles organization with no limits", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/limits",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(0);
    });

    test("excludes limits for soft-deleted agents", async ({ makeAgent }) => {
      const activeAgent = await makeAgent({
        name: "Active Limit Agent",
        organizationId,
      });
      const deletedAgent = await makeAgent({
        name: "Deleted Limit Agent",
        organizationId,
      });
      const activeLimit = await LimitModel.create({
        entityType: "agent",
        entityId: activeAgent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["gpt-4o"],
      });
      const deletedLimit = await LimitModel.create({
        entityType: "agent",
        entityId: deletedAgent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["gpt-4o"],
      });

      await AgentModel.delete(deletedAgent.id);

      const response = await app.inject({
        method: "GET",
        url: "/api/limits",
      });

      expect(response.statusCode).toBe(200);
      const limitIds = response.json().map((limit: { id: string }) => limit.id);
      expect(limitIds).toContain(activeLimit.id);
      expect(limitIds).not.toContain(deletedLimit.id);
    });

    test("cleanup with allForOrganizationId respects per-limit cleanup intervals", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({
        name: "Test Agent",
        organizationId,
      });

      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["gpt-4o"],
      });

      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "gpt-4o",
        500,
        500,
      );

      // First day of the previous calendar month, so the default
      // calendar_month cleanup fires regardless of today's day-of-month.
      const oldDate = new Date();
      oldDate.setDate(1);
      oldDate.setMonth(oldDate.getMonth() - 1);
      await LimitModel.patch(limit.id, { lastCleanup: oldDate });

      const response = await app.inject({
        method: "GET",
        url: "/api/limits",
      });

      expect(response.statusCode).toBe(200);

      const body = response.json();
      const returnedLimit = body.find((l: { id: string }) => l.id === limit.id);
      expect(returnedLimit).toBeDefined();

      const gpt4oUsage = returnedLimit.modelUsage.find(
        (u: { model: string }) => u.model === "gpt-4o",
      );
      expect(gpt4oUsage.tokensIn).toBe(0);
      expect(gpt4oUsage.tokensOut).toBe(0);
    });

    test("calls cleanupLimitsIfNeeded with query parameters when provided", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({
        name: "Test Agent",
        organizationId,
      });

      await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["gpt-4o"],
      });

      const cleanupSpy = vi.spyOn(LimitModel, "cleanupLimitsIfNeeded");

      const response = await app.inject({
        method: "GET",
        url: `/api/limits?entityType=agent&entityId=${agent.id}&limitType=token_cost`,
      });

      expect(response.statusCode).toBe(200);
      expect(cleanupSpy).toHaveBeenCalledWith({
        allForOrganizationId: organizationId,
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
      });

      cleanupSpy.mockRestore();
    });
  });

  describe("POST /api/limits", () => {
    test("defaults new limits to calendar-month cleanup", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/limits",
        payload: {
          entityType: "organization",
          entityId: organizationId,
          limitType: "token_cost",
          limitValue: 1000,
          model: ["gpt-4o"],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        cleanupInterval: "calendar_month",
      });
    });

    test("creates a limit with a calendar-aligned cleanup interval", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/limits",
        payload: {
          entityType: "organization",
          entityId: organizationId,
          limitType: "token_cost",
          limitValue: 1000,
          cleanupInterval: "calendar_month",
          model: ["gpt-4o"],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        entityType: "organization",
        entityId: organizationId,
        limitType: "token_cost",
        limitValue: 1000,
        cleanupInterval: "calendar_month",
        model: ["gpt-4o"],
      });
    });
  });

  describe("PATCH /api/limits/:id", () => {
    test("resets usage when cleanup interval changes", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({
        name: "Interval Reset Agent",
        organizationId,
      });
      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["gpt-4o"],
        cleanupInterval: "1w",
      });
      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "gpt-4o",
        500,
        700,
      );

      const response = await app.inject({
        method: "PATCH",
        url: `/api/limits/${limit.id}`,
        payload: {
          cleanupInterval: "calendar_month",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        cleanupInterval: "calendar_month",
      });
      const usage = await LimitModel.getRawModelUsage(limit.id);
      expect(usage[0].currentUsageTokensIn).toBe(0);
      expect(usage[0].currentUsageTokensOut).toBe(0);
    });

    test("does not reset usage when cleanup interval is unchanged", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({
        name: "Value Update Agent",
        organizationId,
      });
      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000000,
        model: ["gpt-4o"],
        cleanupInterval: "1w",
      });
      await LimitModel.updateTokenLimitUsage(
        "agent",
        agent.id,
        "gpt-4o",
        500,
        700,
      );

      const response = await app.inject({
        method: "PATCH",
        url: `/api/limits/${limit.id}`,
        payload: {
          limitValue: 2000000,
          cleanupInterval: "1w",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        limitValue: 2000000,
        cleanupInterval: "1w",
      });
      const usage = await LimitModel.getRawModelUsage(limit.id);
      expect(usage[0].currentUsageTokensIn).toBe(500);
      expect(usage[0].currentUsageTokensOut).toBe(700);
    });
  });

  describe("environment-scoped limits", () => {
    test("creates and lists an environment limit for the caller's org", async () => {
      const environment = await EnvironmentModel.create({
        organizationId,
        name: "production",
      });

      const createResponse = await app.inject({
        method: "POST",
        url: "/api/limits",
        payload: {
          entityType: "environment",
          entityId: environment.id,
          limitType: "token_cost",
          limitValue: 5000,
          model: ["gpt-4o"],
        },
      });

      expect(createResponse.statusCode).toBe(200);
      expect(createResponse.json()).toMatchObject({
        entityType: "environment",
        entityId: environment.id,
        limitValue: 5000,
      });

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/limits?entityType=environment",
      });
      expect(listResponse.statusCode).toBe(200);
      const ids = listResponse.json().map((l: { id: string }) => l.id);
      expect(ids).toContain(createResponse.json().id);
    });

    test("rejects an environment limit for an environment in another org", async ({
      makeOrganization,
    }) => {
      const otherOrg = await makeOrganization();
      const foreignEnvironment = await EnvironmentModel.create({
        organizationId: otherOrg.id,
        name: "foreign",
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/limits",
        payload: {
          entityType: "environment",
          entityId: foreignEnvironment.id,
          limitType: "token_cost",
          limitValue: 5000,
          model: ["gpt-4o"],
        },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("org-scoping guards", () => {
    test("rejects creating a limit for an agent in another org", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const otherOrg = await makeOrganization();
      const foreignAgent = await makeAgent({
        name: "Foreign Agent",
        organizationId: otherOrg.id,
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/limits",
        payload: {
          entityType: "agent",
          entityId: foreignAgent.id,
          limitType: "token_cost",
          limitValue: 1000,
          model: ["gpt-4o"],
        },
      });

      expect(response.statusCode).toBe(404);
    });

    test("rejects creating an organization limit for another org", async ({
      makeOrganization,
    }) => {
      const otherOrg = await makeOrganization();

      const response = await app.inject({
        method: "POST",
        url: "/api/limits",
        payload: {
          entityType: "organization",
          entityId: otherOrg.id,
          limitType: "token_cost",
          limitValue: 1000,
          model: ["gpt-4o"],
        },
      });

      expect(response.statusCode).toBe(404);
    });

    test("GET/PATCH/DELETE on another org's limit return 404", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const otherOrg = await makeOrganization();
      const foreignAgent = await makeAgent({
        name: "Foreign Agent",
        organizationId: otherOrg.id,
      });
      const foreignLimit = await LimitModel.create({
        entityType: "agent",
        entityId: foreignAgent.id,
        limitType: "token_cost",
        limitValue: 1000,
        model: ["gpt-4o"],
      });

      const getResponse = await app.inject({
        method: "GET",
        url: `/api/limits/${foreignLimit.id}`,
      });
      expect(getResponse.statusCode).toBe(404);

      const patchResponse = await app.inject({
        method: "PATCH",
        url: `/api/limits/${foreignLimit.id}`,
        payload: { limitValue: 9999 },
      });
      expect(patchResponse.statusCode).toBe(404);

      const deleteResponse = await app.inject({
        method: "DELETE",
        url: `/api/limits/${foreignLimit.id}`,
      });
      expect(deleteResponse.statusCode).toBe(404);

      // Untouched in the other org.
      const stillThere = await LimitModel.findById(foreignLimit.id);
      expect(stillThere?.limitValue).toBe(1000);
    });

    test("PATCH ignores attempts to change entityType/entityId", async ({
      makeAgent,
      makeOrganization,
    }) => {
      const agent = await makeAgent({
        name: "Scoped Agent",
        organizationId,
      });
      const limit = await LimitModel.create({
        entityType: "agent",
        entityId: agent.id,
        limitType: "token_cost",
        limitValue: 1000,
        model: ["gpt-4o"],
      });

      const otherOrg = await makeOrganization();
      const foreignAgent = await makeAgent({
        name: "Foreign Agent",
        organizationId: otherOrg.id,
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/limits/${limit.id}`,
        payload: {
          limitValue: 2000,
          entityType: "agent",
          entityId: foreignAgent.id,
        },
      });

      expect(response.statusCode).toBe(200);
      const updated = await LimitModel.findById(limit.id);
      expect(updated?.entityId).toBe(agent.id);
      expect(updated?.limitValue).toBe(2000);
    });
  });
});
