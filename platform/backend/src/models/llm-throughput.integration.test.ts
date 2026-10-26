import { LlmThroughput } from "@/services/llm-throughput";
import { describe, expect, test } from "@/test";
import LimitModel from "./limit";
import LlmThroughputModel from "./llm-throughput";

describe("LLM throughput integration", () => {
  test("does not charge missing or zero usage when max_tokens is unbounded", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const tokens = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "tokens",
      cleanupInterval: "calendar_day",
      limitValue: 1000,
    });
    const requests = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "requests",
      cleanupInterval: "calendar_day",
      limitValue: 5,
    });
    const scope = {
      entities: [{ entityType: "organization" as const, entityId: org.id }],
      model: "model-a",
    };
    const missing = new LlmThroughput(scope);
    await missing.admit({ max_tokens: 2147483647 });
    await missing.reconcile(undefined);
    const zero = new LlmThroughput(scope);
    await zero.admit({ max_tokens: 2147483647 });
    await zero.reconcile({ inputTokens: 0, outputTokens: 0 });
    const usage = await LlmThroughputModel.usage([tokens, requests]);
    expect(usage.get(tokens.id)?.currentUsage).toBe(0);
    expect(usage.get(requests.id)?.currentUsage).toBe(2);
  });

  test("admits a huge max_tokens bound, then blocks only after actual debt", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const tokens = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "tokens",
      cleanupInterval: "calendar_day",
      limitValue: 100,
    });
    const scope = {
      entities: [{ entityType: "organization" as const, entityId: org.id }],
      model: "model-a",
    };
    const call = new LlmThroughput(scope);
    await call.admit({
      max_tokens: 2147483647,
      messages: [{ content: "No forecast" }],
    });
    expect(
      (await LlmThroughputModel.usage([tokens])).get(tokens.id)?.currentUsage,
    ).toBe(0);
    await call.reconcile({ inputTokens: 40000, outputTokens: 10000 });
    expect(
      (await LlmThroughputModel.usage([tokens])).get(tokens.id)?.currentUsage,
    ).toBe(50000);
    await expect(
      new LlmThroughput(scope).admit({ max_tokens: 1 }),
    ).rejects.toMatchObject({
      status: 429,
      code: "archestra_quota_exceeded",
      quota: {
        limitType: "tokens",
        oversized: false,
        retryAfter: expect.any(Number),
      },
    });
  });

  test("settles the same completion twice without charging it twice", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const tokens = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "tokens",
      cleanupInterval: "calendar_day",
      limitValue: 1000,
    });
    const call = new LlmThroughput({
      entities: [{ entityType: "organization", entityId: org.id }],
      model: "model-a",
    });
    await call.admit();
    await Promise.all([
      call.reconcile({ inputTokens: 40, outputTokens: 10 }),
      call.reconcile({ inputTokens: 40, outputTokens: 10 }),
    ]);
    expect(
      (await LlmThroughputModel.usage([tokens])).get(tokens.id)?.currentUsage,
    ).toBe(50);
  });

  test("counts subscription tokens and requests while leaving spend at zero", async ({
    makeOrganization,
  }) => {
    const subscribed = await makeOrganization();
    const metered = await makeOrganization();
    const tokens = await LimitModel.create({
      entityType: "organization",
      entityId: subscribed.id,
      limitType: "tokens",
      cleanupInterval: "calendar_day",
      limitValue: 1000,
    });
    const requests = await LimitModel.create({
      entityType: "organization",
      entityId: subscribed.id,
      limitType: "requests",
      cleanupInterval: "calendar_day",
      limitValue: 5,
    });
    const spend = await LimitModel.create({
      entityType: "organization",
      entityId: subscribed.id,
      limitType: "token_cost",
      cleanupInterval: "minute",
      limitValue: 10,
    });
    const meteredSpend = await LimitModel.create({
      entityType: "organization",
      entityId: metered.id,
      limitType: "token_cost",
      cleanupInterval: "minute",
      limitValue: 10,
    });
    const subscription = new LlmThroughput({
      entities: [{ entityType: "organization", entityId: subscribed.id }],
      model: "model-a",
      subscription: true,
    });
    await subscription.admit({ max_tokens: 2147483647 });
    await subscription.reconcile({ inputTokens: 9, outputTokens: 6 });
    await subscription.settleSpend(4);
    const usage = await LlmThroughputModel.usage([tokens, requests, spend]);
    expect(usage.get(tokens.id)?.currentUsage).toBe(15);
    expect(usage.get(requests.id)?.currentUsage).toBe(1);
    expect(usage.get(spend.id)?.currentUsage).toBe(0);
    const billed = new LlmThroughput({
      entities: [{ entityType: "organization", entityId: metered.id }],
      model: "model-a",
    });
    await billed.admit();
    await billed.settleSpend(4);
    const recorded = (await LlmThroughputModel.usage([meteredSpend])).get(
      meteredSpend.id,
    )?.currentUsage;
    expect(recorded).toBeGreaterThan(0);
    expect(recorded).toBeLessThanOrEqual(4);
  });

  test("charges a late token report to the period opened by an interval edit", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const rule = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "tokens",
      cleanupInterval: "calendar_day",
      limitValue: 1000,
    });
    const scope = {
      entities: [{ entityType: "organization" as const, entityId: org.id }],
      model: "model-a",
    };
    const early = new LlmThroughput(scope);
    await early.admit();
    await early.reconcile({ inputTokens: 30, outputTokens: 10 });
    const late = new LlmThroughput(scope);
    await late.admit({ max_tokens: 2147483647 });
    const edited = await LimitModel.patch(rule.id, {
      cleanupInterval: "calendar_month",
    });
    if (!edited) throw new Error("Expected the edited limit");
    expect(
      (await LlmThroughputModel.usage([edited])).get(edited.id)?.currentUsage,
    ).toBe(0);
    await late.reconcile({ inputTokens: 11, outputTokens: 4 });
    expect(
      (await LlmThroughputModel.usage([edited])).get(edited.id)?.currentUsage,
    ).toBe(15);
  });

  test("preserves recorded usage across a cap edit and enforces the new cap", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const rule = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "tokens",
      cleanupInterval: "calendar_day",
      limitValue: 100,
    });
    const scope = {
      entities: [{ entityType: "organization" as const, entityId: org.id }],
      model: "model-a",
    };
    const call = new LlmThroughput(scope);
    await call.admit();
    await call.reconcile({ inputTokens: 50, outputTokens: 30 });
    const lowered = await LimitModel.patch(rule.id, { limitValue: 40 });
    if (!lowered) throw new Error("Expected the lowered limit");
    expect(
      (await LlmThroughputModel.usage([lowered])).get(lowered.id)?.currentUsage,
    ).toBe(80);
    await expect(new LlmThroughput(scope).admit()).rejects.toMatchObject({
      status: 429,
      code: "archestra_quota_exceeded",
      quota: { limitType: "tokens", oversized: false },
    });
    const raised = await LimitModel.patch(rule.id, { limitValue: 200 });
    if (!raised) throw new Error("Expected the raised limit");
    expect(
      (await LlmThroughputModel.usage([raised])).get(raised.id)?.currentUsage,
    ).toBe(80);
    await expect(new LlmThroughput(scope).admit()).resolves.toBeUndefined();
  });

  test("cancels one admission once and does not refund a later admission", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const requests = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "requests",
      cleanupInterval: "calendar_day",
      limitValue: 2,
    });
    const tokens = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "tokens",
      cleanupInterval: "calendar_day",
      limitValue: 1000,
    });
    const scope = {
      entities: [{ entityType: "organization" as const, entityId: org.id }],
      model: "model-a",
    };
    const first = new LlmThroughput(scope);
    const second = new LlmThroughput(scope);
    await first.admit();
    await second.admit();
    await Promise.all([first.cancelBeforeSend(), first.cancelBeforeSend()]);
    await first.reconcile({ inputTokens: 100, outputTokens: 100 });
    await second.reconcile({ inputTokens: 4, outputTokens: 1 });
    const settled = await LlmThroughputModel.usage([requests, tokens]);
    expect(settled.get(requests.id)?.currentUsage).toBe(1);
    expect(settled.get(tokens.id)?.currentUsage).toBe(5);
    await new LlmThroughput(scope).admit();
    expect(
      (await LlmThroughputModel.usage([requests])).get(requests.id)
        ?.currentUsage,
    ).toBe(2);
    await expect(new LlmThroughput(scope).admit()).rejects.toMatchObject({
      status: 429,
      code: "archestra_quota_exceeded",
      quota: { limitType: "requests", oversized: false },
    });
  });
});
