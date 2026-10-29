import client from "prom-client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const rule = {
  id: "configured-rule",
  entityId: "configured-team",
  entityType: "team" as const,
  limitType: "requests" as const,
  limitValue: 100,
  cleanupInterval: "calendar_day" as const,
};
async function values(name: string) {
  return (await client.register.getSingleMetric(name)?.get())?.values ?? [];
}

describe("limit alert context", () => {
  beforeEach(() => {
    client.register.clear();
    vi.resetModules();
  });
  afterEach(() => {
    client.register.clear();
    vi.restoreAllMocks();
  });

  test("a single soft hit exposes the exact rule, target, interval, threshold and usage", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const { observeLimitCheck } = await import("./limit");
    expect(
      observeLimitCheck({ ...rule, behavior: "soft" }, true, false, 123),
    ).toBe(false);
    const labels = {
      limit_id: rule.id,
      entity_id: rule.entityId,
      entity_type: "team",
      limit_kind: "requests",
      behavior: "soft",
      cleanup_interval: "calendar_day",
      source: "explicit",
    };
    expect(await values("llm_limit_last_exceeded_timestamp_seconds")).toEqual([
      expect.objectContaining({ labels, value: 1_800_000_000 }),
    ]);
    expect(await values("llm_limit_last_exceeded_threshold")).toEqual([
      expect.objectContaining({ labels, value: 100 }),
    ]);
    expect(await values("llm_limit_last_exceeded_usage")).toEqual([
      expect.objectContaining({ labels, value: 123 }),
    ]);
    // Rule identities stay out of the fleet-level counter.
    expect(
      JSON.stringify(await values("llm_limit_checks_total")),
    ).not.toContain(rule.id);
  });

  test("separates rules for the same target and reports hard refusals", async () => {
    const { observeLimitCheck } = await import("./limit");
    expect(observeLimitCheck(rule, true, false, 100)).toBe(true);
    observeLimitCheck(
      { ...rule, id: "other-rule", cleanupInterval: "minute" },
      true,
      false,
      101,
    );
    expect(await values("llm_limit_last_exceeded_threshold")).toHaveLength(2);
    expect(await values("llm_limit_checks_total")).toEqual([
      expect.objectContaining({
        labels: expect.objectContaining({
          behavior: "hard",
          outcome: "blocked",
        }),
        value: 2,
      }),
    ]);
  });

  test("normal checks and unavailable usage cannot create a false exhaustion alert", async () => {
    const { observeLimitCheck } = await import("./limit");
    observeLimitCheck(rule, false, false, 50);
    observeLimitCheck(rule, true, true, Number.POSITIVE_INFINITY);
    expect(await values("llm_limit_last_exceeded_timestamp_seconds")).toEqual(
      [],
    );
    expect(await values("llm_limit_last_exceeded_usage")).toEqual([]);
  });

  test("unknown spend counts hard refusals as blocked and soft allowances as unavailable", async () => {
    const { observeLimitCheck } = await import("./limit");
    expect(observeLimitCheck(rule, true, true, Infinity)).toBe(true);
    expect(
      observeLimitCheck({ ...rule, behavior: "soft" }, true, true, Infinity),
    ).toBe(false);
    expect(await values("llm_limit_checks_total")).toEqual([
      expect.objectContaining({
        labels: expect.objectContaining({
          behavior: "hard",
          outcome: "blocked",
        }),
        value: 1,
      }),
      expect.objectContaining({
        labels: expect.objectContaining({
          behavior: "soft",
          outcome: "usage_unavailable",
        }),
        value: 1,
      }),
    ]);
    expect(await values("llm_limit_last_exceeded_timestamp_seconds")).toEqual(
      [],
    );
  });

  test("default allowances identify the affected account and distinguish their source", async () => {
    const { observeLimitCheck } = await import("./limit");
    observeLimitCheck(
      {
        ...rule,
        entityType: "user",
        entityId: "managed-account",
        limitType: "token_cost",
        source: "default_user",
      },
      true,
      false,
      100,
    );
    expect(await values("llm_limit_last_exceeded_timestamp_seconds")).toEqual([
      expect.objectContaining({
        labels: expect.objectContaining({
          entity_id: "managed-account",
          entity_type: "user",
          source: "default_user",
        }),
      }),
    ]);
  });

  test("updates the last observation without creating per-request series and expires inactive detail", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const { observeLimitCheck } = await import("./limit");
    observeLimitCheck(rule, true, false, 100);
    now.mockReturnValue(1_800_000_001_000);
    observeLimitCheck(rule, true, false, 120);
    expect(await values("llm_limit_last_exceeded_timestamp_seconds")).toEqual([
      expect.objectContaining({ value: 1_800_000_001 }),
    ]);
    expect(await values("llm_limit_last_exceeded_usage")).toEqual([
      expect.objectContaining({ value: 120 }),
    ]);
    now.mockReturnValue(1_800_000_001_000 + 24 * 60 * 60 * 1000 + 1);
    expect(await values("llm_limit_last_exceeded_timestamp_seconds")).toEqual(
      [],
    );
    expect(await values("llm_limit_last_exceeded_threshold")).toEqual([]);
    expect(await values("llm_limit_last_exceeded_usage")).toEqual([]);
  });
});
