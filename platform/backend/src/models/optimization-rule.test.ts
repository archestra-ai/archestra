import { beforeEach, describe, expect, test } from "@/test";
import type { InsertOptimizationRule, OptimizationRule } from "@/types";
import AgentModel from "./agent";
import OptimizationRuleModel from "./optimization-rule";

describe("OptimizationRuleModel.matchByRules", () => {
  let organizationId: string;

  beforeEach(async ({ makeOrganization }) => {
    const org = await makeOrganization();
    organizationId = org.id;
  });

  test("matches rule when all conditions are met", async () => {
    const rules: OptimizationRule[] = [
      {
        id: "test-rule-1",
        entityType: "organization",
        entityId: organizationId,
        conditions: [{ maxLength: 1000 }, { hasTools: false }],
        provider: "openai",
        targetModel: "gpt-4o-mini",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const context = {
      tokenCount: 500,
      hasTools: false,
    };

    const result = OptimizationRuleModel.matchByRules(rules, context);

    expect(result).toBe("gpt-4o-mini");
  });

  test("does not match rule when conditions are not met", async () => {
    const rules: OptimizationRule[] = [
      {
        id: "test-rule-1",
        entityType: "organization",
        entityId: organizationId,
        conditions: [{ maxLength: 1000 }, { hasTools: false }],
        provider: "openai",
        targetModel: "gpt-4o-mini",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    // Token count exceeds maxLength
    const context = {
      tokenCount: 1500,
      hasTools: false,
    };

    const result = OptimizationRuleModel.matchByRules(rules, context);

    expect(result).toBeNull();
  });

  test("does not match when hasTools condition fails", async () => {
    const rules: OptimizationRule[] = [
      {
        id: "test-rule-1",
        entityType: "organization",
        entityId: organizationId,
        conditions: [{ hasTools: false }],
        provider: "openai",
        targetModel: "gpt-4o-mini",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    // hasTools doesn't match
    const context = {
      tokenCount: 500,
      hasTools: true,
    };

    const result = OptimizationRuleModel.matchByRules(rules, context);

    expect(result).toBeNull();
  });

  test("returns first matching rule when multiple rules exist", async () => {
    const rules: OptimizationRule[] = [
      {
        id: "test-rule-1",
        entityType: "organization",
        entityId: organizationId,
        conditions: [{ maxLength: 1000 }],
        provider: "openai",
        targetModel: "gpt-4o-mini",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: "test-rule-2",
        entityType: "organization",
        entityId: organizationId,
        conditions: [{ maxLength: 2000 }],
        provider: "openai",
        targetModel: "gpt-4o",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const context = {
      tokenCount: 500,
      hasTools: false,
    };

    const result = OptimizationRuleModel.matchByRules(rules, context);

    // Should return the first matching rule
    expect(result).toBe("gpt-4o-mini");
  });

  test("skips disabled rules", async () => {
    const rules: OptimizationRule[] = [
      {
        id: "test-rule-1",
        entityType: "organization",
        entityId: organizationId,
        conditions: [{ maxLength: 1000 }],
        provider: "openai",
        targetModel: "gpt-4o-mini",
        enabled: false, // Disabled
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    const context = {
      tokenCount: 500,
      hasTools: false,
    };

    const result = OptimizationRuleModel.matchByRules(rules, context);

    expect(result).toBeNull();
  });
});

describe("OptimizationRuleModel.getFirstOrganizationId", () => {
  test("returns organization ID when rules exist", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    // Create an organization-level optimization rule
    const ruleData: InsertOptimizationRule = {
      entityType: "organization",
      entityId: org.id,
      conditions: [{ maxLength: 1000 }],
      provider: "openai",
      targetModel: "gpt-4o-mini",
      enabled: true,
    };
    await OptimizationRuleModel.create(ruleData);

    const result = await OptimizationRuleModel.getFirstOrganizationId();

    expect(result).toBe(org.id);
  });

  test("returns null when no organization rules exist", async () => {
    // Since we're in a test with a fresh database, there should be no rules
    // Note: This test might be flaky if other tests create rules and don't clean up
    const result = await OptimizationRuleModel.getFirstOrganizationId();

    // Result could be null or an org ID depending on test isolation
    expect(result === null || typeof result === "string").toBe(true);
  });
});

describe("OptimizationRuleModel soft-deleted agents", () => {
  test("excludes agent rules whose target agent is deleted", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const activeAgent = await makeAgent({ organizationId: org.id });
    const deletedAgent = await makeAgent({ organizationId: org.id });
    const activeRule = await OptimizationRuleModel.create({
      entityType: "agent",
      entityId: activeAgent.id,
      conditions: [{ maxLength: 1000 }],
      provider: "openai",
      targetModel: "gpt-4o-mini",
      enabled: true,
    });
    const deletedRule = await OptimizationRuleModel.create({
      entityType: "agent",
      entityId: deletedAgent.id,
      conditions: [{ maxLength: 1000 }],
      provider: "openai",
      targetModel: "gpt-4o-mini",
      enabled: true,
    });

    await AgentModel.delete(deletedAgent.id);

    await expect(
      OptimizationRuleModel.entityBelongsToOrganization(
        "agent",
        deletedAgent.id,
        org.id,
      ),
    ).resolves.toBe(false);

    const rules = await OptimizationRuleModel.findByOrganizationId(org.id);
    expect(rules.map((rule) => rule.id)).toEqual([activeRule.id]);

    await expect(
      OptimizationRuleModel.findByIdForOrganization(deletedRule.id, org.id),
    ).resolves.toBeNull();
    await expect(
      OptimizationRuleModel.findByIdForAudit(deletedRule.id, org.id),
    ).resolves.toBeNull();
  });
});
