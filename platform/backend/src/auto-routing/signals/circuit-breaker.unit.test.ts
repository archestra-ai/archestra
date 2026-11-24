import { describe, expect, test } from "vitest";
import { ScorerCircuitBreaker } from "./circuit-breaker";

describe("ScorerCircuitBreaker", () => {
  test("opens after failureThreshold consecutive transient failures and rejects during cooldown", () => {
    let now = 1_000;
    const breaker = new ScorerCircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 30_000,
      now: () => now,
    });

    for (let i = 0; i < 3; i += 1) {
      const permit = breaker.acquire("k1");
      expect(permit).not.toBeNull();
      if (permit) breaker.recordTransientFailure(permit);
    }

    // Circuit is now open until t = 31_000.
    expect(breaker.acquire("k1")).toBeNull();
    now = 30_999;
    expect(breaker.acquire("k1")).toBeNull();
  });

  test("resets consecutive failure streak on success and neutral outcomes in closed state", () => {
    let now = 1_000;
    const breaker = new ScorerCircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 30_000,
      now: () => now,
    });

    const failTwice = () => {
      for (let i = 0; i < 2; i += 1) {
        const permit = breaker.acquire("k1");
        expect(permit).not.toBeNull();
        if (permit) breaker.recordTransientFailure(permit);
      }
    };

    failTwice();
    const okPermit = breaker.acquire("k1");
    expect(okPermit).not.toBeNull();
    if (okPermit) breaker.recordSuccess(okPermit);

    failTwice();
    const neutralPermit = breaker.acquire("k1");
    expect(neutralPermit).not.toBeNull();
    if (neutralPermit) breaker.recordNeutral(neutralPermit);

    failTwice();
    // Still closed because both streaks were reset before reaching 3.
    const thirdPermit = breaker.acquire("k1");
    expect(thirdPermit).not.toBeNull();
    if (thirdPermit) breaker.recordTransientFailure(thirdPermit);
    expect(breaker.acquire("k1")).toBeNull();

    now += 30_000;
    expect(breaker.acquire("k1")).not.toBeNull();
  });

  test("admits a single-flight half-open probe after cooldown and closes on probe success", () => {
    let now = 1_000;
    const breaker = new ScorerCircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 30_000,
      now: () => now,
    });

    for (let i = 0; i < 3; i += 1) {
      const permit = breaker.acquire("k1");
      if (permit) breaker.recordTransientFailure(permit);
    }

    now = 31_000;
    const probe = breaker.acquire("k1");
    expect(probe).not.toBeNull();

    // Concurrent caller while probe is in flight is rejected immediately.
    expect(breaker.acquire("k1")).toBeNull();

    if (probe) breaker.recordSuccess(probe);

    // Circuit is closed: multiple concurrent callers are admitted.
    expect(breaker.acquire("k1")).not.toBeNull();
    expect(breaker.acquire("k1")).not.toBeNull();
  });

  test("renews cooldown when a half-open probe ends with a neutral outcome", () => {
    let now = 1_000;
    const breaker = new ScorerCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 10_000,
      now: () => now,
    });

    for (let i = 0; i < 2; i += 1) {
      const permit = breaker.acquire("k1");
      if (permit) breaker.recordTransientFailure(permit);
    }

    now = 11_000;
    const probe = breaker.acquire("k1");
    expect(probe).not.toBeNull();
    expect(breaker.acquire("k1")).toBeNull();

    now = 11_500;
    if (probe) breaker.recordNeutral(probe);

    // Must remain open for a full cooldown from neutral probe settlement.
    now = 21_499;
    expect(breaker.acquire("k1")).toBeNull();

    now = 21_500;
    expect(breaker.acquire("k1")).not.toBeNull();
    expect(breaker.acquire("k1")).toBeNull();
  });

  test("re-opens circuit for a full cooldown when the half-open probe fails", () => {
    let now = 1_000;
    const breaker = new ScorerCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 10_000,
      now: () => now,
    });

    for (let i = 0; i < 2; i += 1) {
      const permit = breaker.acquire("k1");
      if (permit) breaker.recordTransientFailure(permit);
    }

    now = 11_000;
    const probe = breaker.acquire("k1");
    expect(probe).not.toBeNull();

    now = 11_500;
    if (probe) breaker.recordTransientFailure(probe);

    // Must stay open for a full 10_000ms from 11_500.
    now = 21_499;
    expect(breaker.acquire("k1")).toBeNull();

    now = 21_500;
    expect(breaker.acquire("k1")).not.toBeNull();
    expect(breaker.acquire("k1")).toBeNull();
  });

  test("release preserves closed streak and frees half-open probe without extending cooldown", () => {
    let now = 1_000;
    const breaker = new ScorerCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 10_000,
      now: () => now,
    });

    const p1 = breaker.acquire("k1");
    const p2 = breaker.acquire("k1");
    if (p1) breaker.recordTransientFailure(p1);
    // Releasing in closed state does not reset or increment the streak.
    if (p2) breaker.release(p2);

    const p3 = breaker.acquire("k1");
    if (p3) breaker.recordTransientFailure(p3);
    expect(breaker.acquire("k1")).toBeNull();

    now = 11_000;
    const probe1 = breaker.acquire("k1");
    expect(probe1).not.toBeNull();
    expect(breaker.acquire("k1")).toBeNull();

    if (probe1) breaker.release(probe1);

    // Next caller can probe immediately since original openedAt was preserved.
    const probe2 = breaker.acquire("k1");
    expect(probe2).not.toBeNull();
    // Still single-flight while probe2 is active.
    expect(breaker.acquire("k1")).toBeNull();
  });

  test("fences stale permits across open, active half-open probes, clear(), and double settlement", () => {
    let now = 1_000;
    const breaker = new ScorerCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 10_000,
      now: () => now,
    });

    // Double settlement of a single closed permit as transient counts once.
    const singlePermit = breaker.acquire("k-double");
    expect(singlePermit).not.toBeNull();
    if (singlePermit) {
      breaker.recordTransientFailure(singlePermit);
      breaker.recordTransientFailure(singlePermit);
    }
    expect(breaker.acquire("k-double")).not.toBeNull();

    // Stale closed permit settling during open OR active half-open probe is ignored.
    const staleInFlight = breaker.acquire("k1");
    const staleDuringProbe = breaker.acquire("k1");
    const f1 = breaker.acquire("k1");
    const f2 = breaker.acquire("k1");
    if (f1) breaker.recordTransientFailure(f1);
    if (f2) breaker.recordTransientFailure(f2);
    if (staleInFlight) breaker.recordSuccess(staleInFlight);
    expect(breaker.acquire("k1")).toBeNull();

    now = 11_000;
    const activeProbe = breaker.acquire("k1");
    expect(activeProbe).not.toBeNull();
    if (staleDuringProbe) breaker.recordSuccess(staleDuringProbe);
    // Active half-open probe must still block concurrent callers.
    expect(breaker.acquire("k1")).toBeNull();
    if (activeProbe) breaker.recordSuccess(activeProbe);
    expect(breaker.acquire("k1")).not.toBeNull();

    // Permit acquired before clear() cannot affect post-clear state on same key.
    const preClear = breaker.acquire("k1");
    breaker.clear();
    const postClear = breaker.acquire("k1");
    expect(postClear).not.toBeNull();
    if (preClear) breaker.recordTransientFailure(preClear);
    if (postClear) breaker.recordTransientFailure(postClear);
    // Only 1 failure counted after clear(), so circuit stays closed.
    expect(breaker.acquire("k1")).not.toBeNull();
  });

  test("evicts oldest closed entry past maxEntries while preserving open and half-open entries", () => {
    let now = 1_000;
    const breaker = new ScorerCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 10_000,
      maxEntries: 2,
      now: () => now,
    });

    // k-open transitions to open first.
    const o1 = breaker.acquire("k-open");
    const o2 = breaker.acquire("k-open");
    if (o1) breaker.recordTransientFailure(o1);
    if (o2) breaker.recordTransientFailure(o2);
    expect(breaker.acquire("k-open")).toBeNull();

    // k-closed stays closed with 1 failure.
    const c1 = breaker.acquire("k-closed");
    if (c1) breaker.recordTransientFailure(c1);

    // Inserting k-new evicts k-closed (oldest closed), NOT k-open.
    const n1 = breaker.acquire("k-new");
    expect(n1).not.toBeNull();
    if (n1) breaker.recordSuccess(n1);
    expect(breaker.acquire("k-open")).toBeNull();

    // Now open k-new later (t = 5_000) and move k-open to half-open at t = 11_000
    // so ALL entries are non-closed (one half-open, one still in cooldown).
    now = 5_000;
    const n2 = breaker.acquire("k-new");
    const n3 = breaker.acquire("k-new");
    if (n2) breaker.recordTransientFailure(n2);
    if (n3) breaker.recordTransientFailure(n3);
    expect(breaker.acquire("k-new")).toBeNull();

    now = 11_000;
    const probe = breaker.acquire("k-open");
    expect(probe).not.toBeNull();
    expect(breaker.acquire("k-open")).toBeNull();

    // Both slots are open/half-open: a new key gets an untracked permit
    // without evicting either active cooldown or probe.
    const untracked1 = breaker.acquire("k-overflow");
    const untracked2 = breaker.acquire("k-overflow");
    expect(untracked1).not.toBeNull();
    expect(untracked2).not.toBeNull();
    if (untracked1) breaker.recordTransientFailure(untracked1);
    if (untracked2) breaker.recordTransientFailure(untracked2);
    // Still untracked (no-op settlement) and active entries remain intact.
    expect(breaker.acquire("k-overflow")).not.toBeNull();
    expect(breaker.acquire("k-open")).toBeNull();
    expect(breaker.acquire("k-new")).toBeNull();
  });

  test("reclaims an expired open entry when full without disturbing active cooldowns", () => {
    let now = 1_000;
    const breaker = new ScorerCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 10_000,
      maxEntries: 2,
      now: () => now,
    });

    // k-expired opens at t = 1_000 (expires at 11_000).
    const e1 = breaker.acquire("k-expired");
    if (e1) breaker.recordTransientFailure(e1);

    // k-active opens at t = 6_000 (expires at 16_000).
    now = 6_000;
    const a1 = breaker.acquire("k-active");
    if (a1) breaker.recordTransientFailure(a1);

    // At t = 12_000, k-expired has elapsed its cooldown while k-active is still cooling down.
    now = 12_000;
    const reclaimed = breaker.acquire("k-reclaimed");
    expect(reclaimed).not.toBeNull();
    if (reclaimed) breaker.recordTransientFailure(reclaimed);

    // k-reclaimed was tracked (reclaimed the expired slot) and is now open,
    // while k-active's active cooldown was preserved.
    expect(breaker.acquire("k-reclaimed")).toBeNull();
    expect(breaker.acquire("k-active")).toBeNull();
  });

  test("honors per-failure cooldownMs overrides when opening or reopening", () => {
    let now = 1_000;
    const breaker = new ScorerCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 30_000,
      now: () => now,
    });

    const p1 = breaker.acquire("k1");
    if (p1) breaker.recordTransientFailure(p1, { cooldownMs: 2_000 });

    now = 2_999;
    expect(breaker.acquire("k1")).toBeNull();

    // Probes after the 2s override instead of waiting 30s.
    now = 3_000;
    const probe = breaker.acquire("k1");
    expect(probe).not.toBeNull();
    expect(breaker.acquire("k1")).toBeNull();

    if (probe) breaker.recordSuccess(probe);
    expect(breaker.acquire("k1")).not.toBeNull();
  });

  test("isolates independent keys and clear() resets all open entries", () => {
    const breaker = new ScorerCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 60_000,
      now: () => 1_000,
    });

    const p = breaker.acquire("k1");
    if (p) breaker.recordTransientFailure(p);
    expect(breaker.acquire("k1")).toBeNull();
    expect(breaker.acquire("k2")).not.toBeNull();

    breaker.clear();
    expect(breaker.acquire("k1")).not.toBeNull();
  });
});
