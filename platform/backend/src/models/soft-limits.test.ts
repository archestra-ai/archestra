import { eq } from "drizzle-orm";
import client from "prom-client";
import db, { schema } from "@/database";
import { LlmThroughput } from "@/services/llm-throughput";
import { describe, expect, test } from "@/test";
import EnvironmentDefaultUserLimitModel from "./environment-default-user-limit";
import LimitModel, { LimitValidationService } from "./limit";
import LlmThroughputModel from "./llm-throughput";

async function checks() {
  return client.register.getSingleMetric("llm_limit_checks_total")?.get();
}
async function observed(outcome: string, behavior: string, kind: string) {
  const metric = await checks();
  return (
    metric?.values
      .filter(
        (sample) =>
          sample.labels.outcome === outcome &&
          sample.labels.behavior === behavior &&
          sample.labels.limit_kind === kind,
      )
      .reduce((sum, sample) => sum + sample.value, 0) ?? 0
  );
}

describe("soft limits", () => {
  test("a soft custom user budget preserves the hard default allowance and unpriced-media guard", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeInteraction,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id);
    const agent = await makeAgent({ organizationId: org.id });
    await EnvironmentDefaultUserLimitModel.create({
      organizationId: org.id,
      environmentId: null,
      limitValue: 1,
      model: ["gpt-4o"],
      cleanupInterval: "1w",
    });
    const interaction = await makeInteraction(agent.id, {
      model: "gpt-4o",
      cost: "2",
    });
    await db
      .update(schema.interactionsTable)
      .set({ userId: user.id })
      .where(eq(schema.interactionsTable.id, interaction.id));
    const custom = await LimitModel.create({
      entityType: "user",
      entityId: user.id,
      limitType: "token_cost",
      limitValue: 5,
      behavior: "soft",
    });
    const params = { agentId: agent.id, userId: user.id };
    const result =
      await LimitValidationService.checkLimitsBeforeRequest(params);
    expect(result?.[2]).toMatchObject({ source: "default_user" });
    await expect(
      LimitValidationService.checkLimitsBeforeRequest({
        ...params,
        unpricedMediaModel: "gpt-4o",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    // Explicit hard budgets retain the existing default-override behavior.
    await LimitModel.patch(custom.id, { behavior: "hard" });
    await expect(
      LimitValidationService.checkLimitsBeforeRequest(params),
    ).resolves.toBeNull();
  });

  test("continues beyond request thresholds, records usage, and switches to hard without resetting debt", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const rule = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "requests",
      limitValue: 1,
      cleanupInterval: "calendar_day",
      behavior: "soft",
    });
    const scope = {
      entities: [{ entityType: "organization" as const, entityId: org.id }],
      model: "a",
    };
    const before = await observed("exceeded", "soft", "requests");
    await new LlmThroughput(scope).admit();
    await new LlmThroughput(scope).admit();
    await new LlmThroughput(scope).admit();
    expect(await observed("exceeded", "soft", "requests")).toBe(before + 2);
    const exposition = await client.register.metrics();
    expect(exposition).toContain(
      'llm_limit_checks_total{entity_type="organization",limit_kind="requests",behavior="soft",outcome="exceeded"}',
    );
    expect(JSON.stringify(await checks())).not.toContain(rule.id);
    const detail = await client.register
      .getSingleMetric("llm_limit_last_exceeded_usage")
      ?.get();
    expect(detail?.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: expect.objectContaining({
            limit_id: rule.id,
            entity_id: org.id,
            entity_type: "organization",
            behavior: "soft",
            cleanup_interval: "calendar_day",
            source: "explicit",
          }),
          value: 2,
        }),
      ]),
    );
    expect(
      (await LlmThroughputModel.usage([rule])).get(rule.id)?.currentUsage,
    ).toBe(3);
    expect((await checks())?.values).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          labels: expect.objectContaining({
            behavior: "soft",
            outcome: "exceeded",
            limit_kind: "requests",
          }),
          value: expect.any(Number),
        }),
      ]),
    );
    await LimitModel.patch(rule.id, { behavior: "hard" });
    await expect(new LlmThroughput(scope).admit()).rejects.toMatchObject({
      status: 429,
    });
    await LimitModel.patch(rule.id, { behavior: "soft" });
    await expect(new LlmThroughput(scope).admit()).resolves.toBeUndefined();
    expect(
      (await LlmThroughputModel.usage([rule])).get(rule.id)?.currentUsage,
    ).toBe(4);
  });

  test("soft child never bypasses a hard parent and failed admission never charges either", async ({
    makeOrganization,
    makeVirtualApiKey,
  }) => {
    const org = await makeOrganization();
    const key = await makeVirtualApiKey(org.id);
    const parent = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "requests",
      limitValue: 1,
      cleanupInterval: "calendar_day",
    });
    const child = await LimitModel.create({
      entityType: "virtual_key",
      entityId: key.id,
      limitType: "requests",
      limitValue: 1,
      cleanupInterval: "calendar_day",
      behavior: "soft",
    });
    const scope = {
      entities: [
        { entityType: "organization" as const, entityId: org.id },
        { entityType: "virtual_key" as const, entityId: key.id },
      ],
      model: "a",
    };
    await new LlmThroughput(scope).admit();
    await expect(new LlmThroughput(scope).admit()).rejects.toMatchObject({
      status: 429,
    });
    const usage = await LlmThroughputModel.usage([parent, child]);
    expect(usage.get(parent.id)?.currentUsage).toBe(1);
    expect(usage.get(child.id)?.currentUsage).toBe(1);
    expect(parent.behavior).toBe("hard");
  });

  test("reported token usage continues past a soft cap and settlement remains idempotent", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const rule = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "tokens",
      limitValue: 10,
      cleanupInterval: "calendar_month",
      behavior: "soft",
    });
    const scope = {
      entities: [{ entityType: "organization" as const, entityId: org.id }],
      model: "a",
    };
    const call = new LlmThroughput(scope);
    await call.admit();
    await call.reconcile({ inputTokens: 20, outputTokens: 5 });
    await call.reconcile({ inputTokens: 20, outputTokens: 5 });
    await expect(new LlmThroughput(scope).admit()).resolves.toBeUndefined();
    expect(
      (await LlmThroughputModel.usage([rule])).get(rule.id)?.currentUsage,
    ).toBe(25);
  });

  test("soft spend continues while another hard spend rule still rejects", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ name: "Synthetic workload" });
    const rule = await LimitModel.create({
      entityType: "agent",
      entityId: agent.id,
      limitType: "token_cost",
      limitValue: 0,
      behavior: "soft",
    });
    await expect(
      LimitValidationService.checkLimitsBeforeRequest({ agentId: agent.id }),
    ).resolves.toBeNull();
    await LimitModel.patch(rule.id, { behavior: "hard" });
    expect(
      await LimitValidationService.checkLimitsBeforeRequest({
        agentId: agent.id,
      }),
    ).not.toBeNull();
  });
});
