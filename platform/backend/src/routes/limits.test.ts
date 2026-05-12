import { vi } from "vitest";
import { LimitModel } from "@/models";
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

    test("cleanup with allForOrganizationId respects limitCleanupInterval", async ({
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

      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 7);
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
});
