import { vi } from "vitest";
import { EnvironmentDefaultUserLimitModel, EnvironmentModel } from "@/models";
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

describe("default-user-limit routes", () => {
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

    const { default: defaultUserLimitRoutes } = await import(
      "./default-user-limit"
    );
    await app.register(defaultUserLimitRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  describe("POST /api/default-user-limits", () => {
    test("creates the org-wide default when environmentId is omitted", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/default-user-limits",
        payload: { limitValue: 1000, cleanupInterval: "calendar_month" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        environmentId: null,
        organizationId,
        limitValue: 1000,
      });
    });

    test("rejects a second org-wide default with 409", async () => {
      await EnvironmentDefaultUserLimitModel.create({
        organizationId,
        environmentId: null,
        limitValue: 1000,
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/default-user-limits",
        payload: { limitValue: 500 },
      });

      expect(response.statusCode).toBe(409);
    });

    test("creates a per-environment default user limit", async () => {
      const environment = await EnvironmentModel.create({
        organizationId,
        name: "production",
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/default-user-limits",
        payload: {
          environmentId: environment.id,
          limitValue: 500,
          model: ["gpt-4o"],
          cleanupInterval: "calendar_month",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        environmentId: environment.id,
        organizationId,
        limitValue: 500,
        model: ["gpt-4o"],
        cleanupInterval: "calendar_month",
      });
    });

    test("rejects an environment from another org with 404", async ({
      makeOrganization,
    }) => {
      const otherOrg = await makeOrganization();
      const foreignEnvironment = await EnvironmentModel.create({
        organizationId: otherOrg.id,
        name: "foreign",
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/default-user-limits",
        payload: { environmentId: foreignEnvironment.id, limitValue: 500 },
      });

      expect(response.statusCode).toBe(404);
    });

    test("rejects a duplicate limit for the same environment with 409", async () => {
      const environment = await EnvironmentModel.create({
        organizationId,
        name: "production",
      });
      await EnvironmentDefaultUserLimitModel.create({
        organizationId,
        environmentId: environment.id,
        limitValue: 100,
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/default-user-limits",
        payload: { environmentId: environment.id, limitValue: 500 },
      });

      expect(response.statusCode).toBe(409);
    });

    test("rejects a non-positive limit value with 400", async () => {
      const environment = await EnvironmentModel.create({
        organizationId,
        name: "production",
      });

      const response = await app.inject({
        method: "POST",
        url: "/api/default-user-limits",
        payload: { environmentId: environment.id, limitValue: 0 },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe("GET /api/default-user-limits", () => {
    test("lists only the caller org's limits", async ({ makeOrganization }) => {
      const environment = await EnvironmentModel.create({
        organizationId,
        name: "production",
      });
      const mine = await EnvironmentDefaultUserLimitModel.create({
        organizationId,
        environmentId: environment.id,
        limitValue: 500,
      });

      const otherOrg = await makeOrganization();
      const foreignEnvironment = await EnvironmentModel.create({
        organizationId: otherOrg.id,
        name: "foreign",
      });
      const foreign = await EnvironmentDefaultUserLimitModel.create({
        organizationId: otherOrg.id,
        environmentId: foreignEnvironment.id,
        limitValue: 999,
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/default-user-limits",
      });

      expect(response.statusCode).toBe(200);
      const ids = response.json().map((l: { id: string }) => l.id);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(foreign.id);
    });
  });

  describe("PATCH /api/default-user-limits/:id", () => {
    test("updates value, model, and cleanup interval", async () => {
      const environment = await EnvironmentModel.create({
        organizationId,
        name: "production",
      });
      const limit = await EnvironmentDefaultUserLimitModel.create({
        organizationId,
        environmentId: environment.id,
        limitValue: 500,
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/default-user-limits/${limit.id}`,
        payload: {
          limitValue: 750,
          model: ["gpt-4o"],
          cleanupInterval: "calendar_week_monday",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        limitValue: 750,
        model: ["gpt-4o"],
        cleanupInterval: "calendar_week_monday",
      });
    });

    test("returns 404 for a limit in another org", async ({
      makeOrganization,
    }) => {
      const otherOrg = await makeOrganization();
      const foreignEnvironment = await EnvironmentModel.create({
        organizationId: otherOrg.id,
        name: "foreign",
      });
      const foreign = await EnvironmentDefaultUserLimitModel.create({
        organizationId: otherOrg.id,
        environmentId: foreignEnvironment.id,
        limitValue: 999,
      });

      const response = await app.inject({
        method: "PATCH",
        url: `/api/default-user-limits/${foreign.id}`,
        payload: { limitValue: 1 },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("DELETE /api/default-user-limits/:id", () => {
    test("deletes the caller org's limit", async () => {
      const environment = await EnvironmentModel.create({
        organizationId,
        name: "production",
      });
      const limit = await EnvironmentDefaultUserLimitModel.create({
        organizationId,
        environmentId: environment.id,
        limitValue: 500,
      });

      const response = await app.inject({
        method: "DELETE",
        url: `/api/default-user-limits/${limit.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(
        await EnvironmentDefaultUserLimitModel.findByEnvironmentId(
          environment.id,
        ),
      ).toBeNull();
    });

    test("returns 404 for a limit in another org", async ({
      makeOrganization,
    }) => {
      const otherOrg = await makeOrganization();
      const foreignEnvironment = await EnvironmentModel.create({
        organizationId: otherOrg.id,
        name: "foreign",
      });
      const foreign = await EnvironmentDefaultUserLimitModel.create({
        organizationId: otherOrg.id,
        environmentId: foreignEnvironment.id,
        limitValue: 999,
      });

      const response = await app.inject({
        method: "DELETE",
        url: `/api/default-user-limits/${foreign.id}`,
      });

      expect(response.statusCode).toBe(404);
      expect(
        await EnvironmentDefaultUserLimitModel.findByEnvironmentId(
          foreignEnvironment.id,
        ),
      ).not.toBeNull();
    });
  });
});
