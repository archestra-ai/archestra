import { OptimizationRuleModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("optimization rule routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    user = await makeUser();
    const organization = await makeOrganization();
    organizationId = organization.id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (
        request as typeof request & {
          organizationId: string;
        }
      ).organizationId = organizationId;
    });

    const { default: optimizationRuleRoutes } = await import(
      "./optimization-rule"
    );
    await app.register(optimizationRuleRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  describe("GET /api/optimization-rules/:id", () => {
    test("returns an organization rule by ID", async () => {
      const rule = await OptimizationRuleModel.create({
        entityType: "organization",
        entityId: organizationId,
        conditions: [{ maxLength: 1000 }],
        provider: "openai",
        targetModel: "gpt-4o-mini",
        enabled: true,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/optimization-rules/${rule.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: rule.id,
        entityType: "organization",
        entityId: organizationId,
        provider: "openai",
        targetModel: "gpt-4o-mini",
      });
    });

    test("returns a team rule by ID when the team belongs to the organization", async ({
      makeTeam,
    }) => {
      const team = await makeTeam(organizationId, user.id);
      const rule = await OptimizationRuleModel.create({
        entityType: "team",
        entityId: team.id,
        conditions: [{ maxLength: 1000 }],
        provider: "openai",
        targetModel: "gpt-4o-mini",
        enabled: true,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/optimization-rules/${rule.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: rule.id,
        entityType: "team",
        entityId: team.id,
      });
    });

    test("returns an agent rule by ID when the agent belongs to the organization", async ({
      makeAgent,
    }) => {
      const agent = await makeAgent({ organizationId });
      const rule = await OptimizationRuleModel.create({
        entityType: "agent",
        entityId: agent.id,
        conditions: [{ maxLength: 1000 }],
        provider: "openai",
        targetModel: "gpt-4o-mini",
        enabled: true,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/optimization-rules/${rule.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: rule.id,
        entityType: "agent",
        entityId: agent.id,
      });
    });

    test("returns 404 for a rule outside the active organization", async ({
      makeOrganization,
    }) => {
      const otherOrganization = await makeOrganization();
      const rule = await OptimizationRuleModel.create({
        entityType: "organization",
        entityId: otherOrganization.id,
        conditions: [{ maxLength: 1000 }],
        provider: "openai",
        targetModel: "gpt-4o-mini",
        enabled: true,
      });

      const response = await app.inject({
        method: "GET",
        url: `/api/optimization-rules/${rule.id}`,
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe("GET /api/optimization-rules", () => {
    test("includes organization, team, and agent rules for the active organization", async ({
      makeAgent,
      makeTeam,
    }) => {
      const team = await makeTeam(organizationId, user.id);
      const agent = await makeAgent({ organizationId });
      const organizationRule = await OptimizationRuleModel.create({
        entityType: "organization",
        entityId: organizationId,
        conditions: [{ maxLength: 1000 }],
        provider: "openai",
        targetModel: "gpt-4o-mini",
        enabled: true,
      });
      const teamRule = await OptimizationRuleModel.create({
        entityType: "team",
        entityId: team.id,
        conditions: [{ maxLength: 1000 }],
        provider: "openai",
        targetModel: "gpt-4o-mini",
        enabled: true,
      });
      const agentRule = await OptimizationRuleModel.create({
        entityType: "agent",
        entityId: agent.id,
        conditions: [{ maxLength: 1000 }],
        provider: "openai",
        targetModel: "gpt-4o-mini",
        enabled: true,
      });

      const response = await app.inject({
        method: "GET",
        url: "/api/optimization-rules",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().map((rule: { id: string }) => rule.id)).toEqual(
        expect.arrayContaining([
          organizationRule.id,
          teamRule.id,
          agentRule.id,
        ]),
      );
    });
  });

  describe("POST /api/optimization-rules", () => {
    test("does not create a rule for a team outside the active organization", async ({
      makeOrganization,
      makeTeam,
    }) => {
      const otherOrganization = await makeOrganization();
      const otherTeam = await makeTeam(otherOrganization.id, user.id);

      const response = await app.inject({
        method: "POST",
        url: "/api/optimization-rules",
        payload: {
          entityType: "team",
          entityId: otherTeam.id,
          conditions: [{ maxLength: 1000 }],
          provider: "openai",
          targetModel: "gpt-4o-mini",
          enabled: true,
        },
      });

      expect(response.statusCode).toBe(403);
    });
  });

  describe("PUT /api/optimization-rules/:id", () => {
    test("updates an optimization rule in the active organization", async () => {
      const rule = await OptimizationRuleModel.create({
        entityType: "organization",
        entityId: organizationId,
        conditions: [{ maxLength: 1000 }],
        provider: "openai",
        targetModel: "gpt-4o-mini",
        enabled: true,
      });

      const response = await app.inject({
        method: "PUT",
        url: `/api/optimization-rules/${rule.id}`,
        payload: { enabled: false },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: rule.id,
        enabled: false,
      });
    });

    test("does not update a rule outside the active organization", async ({
      makeOrganization,
    }) => {
      const otherOrganization = await makeOrganization();
      const rule = await OptimizationRuleModel.create({
        entityType: "organization",
        entityId: otherOrganization.id,
        conditions: [{ maxLength: 1000 }],
        provider: "openai",
        targetModel: "gpt-4o-mini",
        enabled: true,
      });

      const response = await app.inject({
        method: "PUT",
        url: `/api/optimization-rules/${rule.id}`,
        payload: { enabled: false },
      });

      expect(response.statusCode).toBe(404);
    });

    test("does not move a rule to an entity outside the active organization", async ({
      makeOrganization,
      makeTeam,
    }) => {
      const otherOrganization = await makeOrganization();
      const otherTeam = await makeTeam(otherOrganization.id, user.id);
      const rule = await OptimizationRuleModel.create({
        entityType: "organization",
        entityId: organizationId,
        conditions: [{ maxLength: 1000 }],
        provider: "openai",
        targetModel: "gpt-4o-mini",
        enabled: true,
      });

      const response = await app.inject({
        method: "PUT",
        url: `/api/optimization-rules/${rule.id}`,
        payload: {
          entityType: "team",
          entityId: otherTeam.id,
        },
      });

      expect(response.statusCode).toBe(403);
      await expect(
        OptimizationRuleModel.findByIdForOrganization(rule.id, organizationId),
      ).resolves.toMatchObject({
        id: rule.id,
        entityType: "organization",
        entityId: organizationId,
      });
    });
  });

  describe("DELETE /api/optimization-rules/:id", () => {
    test("does not delete a rule outside the active organization", async ({
      makeOrganization,
    }) => {
      const otherOrganization = await makeOrganization();
      const rule = await OptimizationRuleModel.create({
        entityType: "organization",
        entityId: otherOrganization.id,
        conditions: [{ maxLength: 1000 }],
        provider: "openai",
        targetModel: "gpt-4o-mini",
        enabled: true,
      });

      const response = await app.inject({
        method: "DELETE",
        url: `/api/optimization-rules/${rule.id}`,
      });

      expect(response.statusCode).toBe(404);
      await expect(
        OptimizationRuleModel.findByIdForOrganization(
          rule.id,
          otherOrganization.id,
        ),
      ).resolves.toMatchObject({ id: rule.id });
    });
  });
});
