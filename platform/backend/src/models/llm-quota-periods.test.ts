import { LlmThroughput } from "@/services/llm-throughput";
import { describe, expect, test } from "@/test";
import { CreateLimitSchema, LimitCleanupIntervalSchema } from "@/types/limit";
import CacheEntryModel from "./cache-entry";
import LimitModel, { LimitValidationService } from "./limit";
import LlmThroughputModel from "./llm-throughput";

describe("unit and interval quotas", () => {
  test("proxy validation cleans expired non-budget counters without resetting throughput", async ({
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const mcp = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "mcp_server_calls",
      mcpServerName: "synthetic-counter",
      cleanupInterval: "calendar_day",
      limitValue: 10,
    });
    const throughput = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "requests",
      cleanupInterval: "calendar_day",
      limitValue: 10,
    });
    await expect(
      LimitValidationService.checkLimitsBeforeRequest({ agentId: agent.id }),
    ).resolves.toBeNull();
    expect((await LimitModel.findById(mcp.id))?.lastCleanup).toBeInstanceOf(
      Date,
    );
    expect((await LimitModel.findById(throughput.id))?.lastCleanup).toBeNull();
  });

  test("scoped budget cleanup preserves throughput windows and minute spend", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const budget = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "token_cost",
      cleanupInterval: "calendar_day",
      limitValue: 10,
    });
    const untouched = [];
    for (const [limitType, cleanupInterval] of [
      ["requests", "minute"],
      ["tokens", "calendar_day"],
      ["token_cost", "minute"],
    ] as const)
      untouched.push(
        await LimitModel.create({
          entityType: "organization",
          entityId: org.id,
          limitType,
          cleanupInterval,
          limitValue: 10,
        }),
      );
    const scope = { entities: { organization: org.id } };
    expect(await LimitModel.findLimitIdsToReset(scope)).toEqual([budget.id]);
    await LimitModel.cleanupLimitsIfNeeded(scope);
    expect((await LimitModel.findById(budget.id))?.lastCleanup).toBeInstanceOf(
      Date,
    );
    for (const rule of untouched)
      expect((await LimitModel.findById(rule.id))?.lastCleanup).toBeNull();
  });
  test("interval epochs advance monotonically and reject old minute spend receipts", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const rule = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "token_cost",
      cleanupInterval: "minute",
      limitValue: 1,
    });
    // A future previous epoch exercises the same safety condition as clock
    // rollback, without changing the process or database clock.
    const previous = new Date(Date.now() + 60000);
    await LimitModel.patch(rule.id, { lastCleanup: previous });
    const admitted = await LlmThroughputModel.admit({
      entities: [{ entityType: "organization", entityId: org.id }],
      model: "model-a",
    });
    if (!("reservation" in admitted) || !admitted.reservation)
      throw new Error("Expected admission");
    const day = await LimitModel.patch(rule.id, {
      cleanupInterval: "calendar_day",
    });
    const minute = await LimitModel.patch(rule.id, {
      cleanupInterval: "minute",
    });
    if (!day?.lastCleanup || !minute?.lastCleanup)
      throw new Error("Expected interval epochs");
    expect(day.lastCleanup.getTime()).toBeGreaterThan(previous.getTime());
    expect(minute.lastCleanup.getTime()).toBeGreaterThan(
      day.lastCleanup.getTime(),
    );
    await LlmThroughputModel.reconcile({
      reservation: admitted.reservation,
      tokens: 0,
      spend: 0.5,
    });
    expect(
      (await LlmThroughputModel.usage([minute])).get(rule.id)?.currentUsage,
    ).toBe(0);
  });
  test("every longer spend interval retains billed-spend admission", async ({
    makeOrganization,
    makeAgent,
  }) => {
    for (const cleanupInterval of LimitCleanupIntervalSchema.options) {
      if (cleanupInterval === "minute") continue;
      const org = await makeOrganization();
      const agent = await makeAgent({ organizationId: org.id });
      const rule = await LimitModel.create({
        entityType: "organization",
        entityId: org.id,
        limitType: "token_cost",
        cleanupInterval,
        limitValue: 1,
        model: ["model-a"],
      });
      await LimitModel.patch(rule.id, { lastCleanup: new Date() });
      expect(
        await LimitValidationService.checkLimitsBeforeRequest({
          agentId: agent.id,
        }),
      ).toBeNull();
      await LimitModel.updateTokenLimitUsage(
        "organization",
        org.id,
        "model-a",
        1000000,
        1000000,
      );
      expect(
        await LimitValidationService.checkLimitsBeforeRequest({
          agentId: agent.id,
        }),
      ).not.toBeNull();
    }
  });
  test("a subscription credential refined to metered still posts actual minute spend", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const rule = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "token_cost",
      cleanupInterval: "minute",
      limitValue: 1,
    });
    const call = new LlmThroughput({
      entities: [{ entityType: "organization", entityId: org.id }],
      model: "model-a",
      subscription: true,
    });
    await call.admit({ messages: [] });
    // The provider's final billing classification is metered, so the handler posts this cost.
    await call.settleSpend("0.45", "metered");
    const used =
      (await LlmThroughputModel.usage([rule])).get(rule.id)?.currentUsage ?? 0;
    expect(used).toBeGreaterThan(0.4);
    expect(used).toBeLessThanOrEqual(0.45);
  });
  test("each long-period receipt records its reported usage independently", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const rule = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "tokens",
      cleanupInterval: "calendar_month",
      limitValue: 2000,
    });
    const params = {
      entities: [{ entityType: "organization" as const, entityId: org.id }],
      model: "model-a",
    };
    for (const admitted of await Promise.all([
      LlmThroughputModel.admit(params),
      LlmThroughputModel.admit(params),
    ])) {
      if (!("reservation" in admitted) || !admitted.reservation)
        throw new Error("Expected admission");
      await LlmThroughputModel.reconcile({
        reservation: admitted.reservation,
        tokens: 10,
      });
    }
    expect(
      (await LlmThroughputModel.usage([rule])).get(rule.id)?.currentUsage,
    ).toBe(20);
  });
  test("persists all thirty combinations and enforces every count period", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const entities = [
      { entityType: "organization" as const, entityId: org.id },
    ];
    for (const type of ["token_cost", "requests", "tokens"] as const) {
      for (const interval of LimitCleanupIntervalSchema.options) {
        const model = `${type}-${interval}`;
        const rule = await LimitModel.create(
          CreateLimitSchema.parse({
            ...entities[0],
            limitType: type,
            cleanupInterval: interval,
            limitValue: 10,
            model: [model],
          }),
        );
        expect(rule.cleanupInterval).toBe(interval);
        const first = await LlmThroughputModel.admit({
          entities,
          model,
        });
        if (type === "token_cost" && interval !== "minute") {
          expect(first).toEqual({ reservation: null });
          continue;
        }
        if (!("reservation" in first) || !first.reservation)
          throw new Error("Expected admission");
        if (type === "token_cost") {
          await LlmThroughputModel.reconcile({
            reservation: first.reservation,
            tokens: 0,
            spend: 10.25,
          });
          const denied = await LlmThroughputModel.admit({
            entities,
            model,
          });
          expect(denied).toHaveProperty("denied.limitType", "token_cost");
        } else {
          if (type === "tokens") {
            await LlmThroughputModel.reconcile({
              reservation: first.reservation,
              tokens: 11,
            });
          }
          const usage = (await LlmThroughputModel.usage([rule])).get(rule.id);
          expect(usage?.currentUsage).toBeGreaterThan(
            type === "tokens" ? 9 : 0.9,
          );
          if (type === "tokens") {
            expect(
              await LlmThroughputModel.admit({ entities, model }),
            ).toHaveProperty("denied");
          }
          if (interval !== "minute")
            expect(usage?.currentUsage).toBe(type === "tokens" ? 11 : 1);
        }
      }
    }
  });

  test("minute spend keeps cents, settles once, permits in-flight overshoot and ignores subscription spend", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const rule = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "token_cost",
      cleanupInterval: "minute",
      limitValue: 1,
    });
    const params = {
      entities: [{ entityType: "organization" as const, entityId: org.id }],
      model: "model-a",
    };
    const a = await LlmThroughputModel.admit(params);
    const b = await LlmThroughputModel.admit(params);
    if (
      !("reservation" in a) ||
      !a.reservation ||
      !("reservation" in b) ||
      !b.reservation
    )
      throw new Error("Expected concurrent admission");
    await LlmThroughputModel.reconcile({
      reservation: a.reservation,
      tokens: 0,
      spend: 0.65,
    });
    await LlmThroughputModel.reconcile({
      reservation: a.reservation,
      tokens: 0,
      spend: 0.65,
    });
    const partial =
      (await LlmThroughputModel.usage([rule])).get(rule.id)?.currentUsage ?? 0;
    expect(partial).toBeGreaterThan(0.6);
    expect(partial).toBeLessThanOrEqual(0.65);
    await LlmThroughputModel.reconcile({
      reservation: b.reservation,
      tokens: 0,
      spend: 0.65,
    });
    expect(await LlmThroughputModel.admit(params)).toHaveProperty(
      "denied.limitType",
      "token_cost",
    );
    expect(
      await LlmThroughputModel.admit({ ...params, subscription: true }),
    ).toHaveProperty("reservation");
  });

  test("actual reports charge the active period once across interval edits and boundaries; cap edits preserve usage", async ({
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
    const params = {
      entities: [{ entityType: "organization" as const, entityId: org.id }],
      model: "model-a",
    };
    const admitted = await LlmThroughputModel.admit(params);
    if (!("reservation" in admitted) || !admitted.reservation)
      throw new Error("Expected admission");
    await LlmThroughputModel.reconcile({
      reservation: admitted.reservation,
      tokens: 80,
    });
    const edited = await LimitModel.patch(rule.id, { limitValue: 200 });
    if (!edited) throw new Error("Expected edited limit");
    expect(
      (await LlmThroughputModel.usage([edited])).get(rule.id)?.currentUsage,
    ).toBe(80);
    const pending = await LlmThroughputModel.admit(params);
    if (!("reservation" in pending) || !pending.reservation)
      throw new Error("Expected pending call");
    const changed = await LimitModel.patch(rule.id, {
      cleanupInterval: "calendar_month",
    });
    if (!changed) throw new Error("Expected changed interval");
    await LlmThroughputModel.admit(params);
    await LlmThroughputModel.reconcile({
      reservation: admitted.reservation,
      tokens: 1,
    });
    await LlmThroughputModel.reconcile({
      reservation: pending.reservation,
      tokens: 40,
    });
    expect(
      (await LlmThroughputModel.usage([changed])).get(rule.id)?.currentUsage,
    ).toBe(40);
    const second = await LlmThroughputModel.admit(params);
    if (!("reservation" in second) || !second.reservation)
      throw new Error("Expected admission");
    // Isolated storage fixture: cross a period boundary before completion.
    const key = `keyv:llm-throughput-counter-actual-tokens-v1-${rule.id}`;
    await CacheEntryModel.withLock(
      `llm-throughput:${rule.id}`,
      async (entries) => {
        const stored = await entries.get(key);
        if (!stored) throw new Error("Expected initialized token counter");
        const raw = JSON.parse(stored);
        raw.value.periodEnd = 1;
        await entries.set(key, JSON.stringify(raw));
      },
    );
    await LlmThroughputModel.admit(params);
    await LlmThroughputModel.reconcile({
      reservation: second.reservation,
      tokens: 500,
    });
    await LlmThroughputModel.reconcile({
      reservation: second.reservation,
      tokens: 500,
    });
    expect(
      (await LlmThroughputModel.usage([changed])).get(rule.id)?.currentUsage,
    ).toBe(500);
  });

  test("same-unit legacy conversion supports another interval, but unit/scope changes reject", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const rule = await LimitModel.create({
      entityType: "organization",
      entityId: org.id,
      limitType: "requests_per_minute",
      limitValue: 60,
    });
    expect(
      await LimitModel.patch(rule.id, {
        limitType: "requests",
        cleanupInterval: "calendar_month",
      }),
    ).toMatchObject({
      limitType: "requests",
      cleanupInterval: "calendar_month",
    });
    await expect(
      LimitModel.patch(rule.id, { limitType: "tokens" }),
    ).rejects.toThrow();
    await expect(
      LimitModel.patch(rule.id, { entityId: "other" }),
    ).rejects.toThrow();
  });
});
