import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { RateLimiterRes } from "rate-limiter-flexible";
import { describe, expect, test, vi } from "vitest";
import { cacheManager } from "@/cache-manager";
import db from "@/database";
import { setupTestCacheManager } from "@/test/cache-manager";
import {
  McpGatewayAuthenticationBusyError,
  McpGatewayRateLimiter,
  withMcpGatewayAuthenticationCapacity,
} from "./mcp-gateway-rate-limit";

setupTestCacheManager();

describe("gateway attempt budgets", () => {
  test("admits only ten simultaneous attempts across replicas and resets at the original window end", async () => {
    const replicas = [new McpGatewayRateLimiter(), new McpGatewayRateLimiter()];
    const caller = { credential: randomUUID(), gateway: randomUUID() };
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const attempts = await Promise.allSettled(
        Array.from({ length: 16 }, (_, i) =>
          replicas[i % 2].consume("192.0.2.1", 1, caller),
        ),
      );
      expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(10);
      const denied = attempts.filter((r) => r.status === "rejected");
      expect(denied).toHaveLength(6);
      for (const result of denied) {
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(RateLimiterRes);
          expect(result.reason.msBeforeNext).toBe(60_000);
        }
      }
      clock.mockReturnValue(now + 59_000);
      await expect(
        replicas[0].consume("192.0.2.1", 1, caller),
      ).rejects.toMatchObject({
        msBeforeNext: 1_000,
      });
      clock.mockReturnValue(now + 60_001);
      await expect(
        replicas[1].consume("192.0.2.1", 1, caller),
      ).resolves.toMatchObject({
        consumedPoints: 1,
      });
    } finally {
      clock.mockRestore();
    }
  });

  test("bounds rotating-credential storage without sharing a lockout across clients", async () => {
    const first = new McpGatewayRateLimiter();
    const second = new McpGatewayRateLimiter();
    const caller = { credential: randomUUID(), gateway: randomUUID() };
    await first.consume("192.0.2.2", 1, caller);
    await first.recordSuccess(caller);
    for (let i = 0; i < 150; i += 1) {
      await second.consume("192.0.2.2", 1, {
        ...caller,
        credential: randomUUID(),
      });
    }
    for (let i = 0; i < 20; i += 1) {
      await expect(
        second.consume("192.0.2.2", 1, caller),
      ).resolves.toMatchObject({ consumedPoints: 0 });
    }
    // Fresh credentials and another gateway have their own allowances on this IP.
    await expect(
      second.consume("192.0.2.2", 1, { ...caller, credential: randomUUID() }),
    ).resolves.toMatchObject({ consumedPoints: 1 });
    await expect(
      second.consume("192.0.2.2", 1, { ...caller, gateway: randomUUID() }),
    ).resolves.toMatchObject({ consumedPoints: 1 });
    await second.recordDenial(caller);
    await expect(second.consume("192.0.2.2", 1, caller)).resolves.toMatchObject(
      { consumedPoints: 1 },
    );
    const rows = await db.execute(sql`SELECT key, value FROM keyv_cache`);
    expect(JSON.stringify(rows.rows)).not.toContain(caller.credential);
    // One bounded map for the IP, even after 150 distinct guesses.
    expect(rows.rows).toHaveLength(1);
    const stored = JSON.parse(String(rows.rows[0].value));
    expect(Object.keys(stored.value)).toHaveLength(100);
  });

  test("reserves bounded verified capacity and releases both pools on success or error", async () => {
    let release = () => {};
    const pendingWork = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = Array.from({ length: 16 }, () =>
      withMcpGatewayAuthenticationCapacity(() => pendingWork),
    );
    let verified: Promise<void>[] = [];
    let queued: Promise<boolean> | undefined;
    try {
      for (const limiter of [
        new McpGatewayRateLimiter(),
        new McpGatewayRateLimiter(),
      ]) {
        await expect(
          limiter.consume("192.0.2.8", 1, {
            credential: randomUUID(),
            gateway: randomUUID(),
          }),
        ).rejects.toBeInstanceOf(McpGatewayAuthenticationBusyError);
      }
      await expect(
        withMcpGatewayAuthenticationCapacity(async () => true),
      ).rejects.toBeInstanceOf(McpGatewayAuthenticationBusyError);
      // Unverified saturation cannot consume the reserved verified pool.
      verified = Array.from({ length: 16 }, () =>
        withMcpGatewayAuthenticationCapacity(() => pendingWork, {
          pool: "verified",
          credential: randomUUID(),
        }),
      );
      // With both pools full, a verified caller waits for a reserved slot.
      queued = withMcpGatewayAuthenticationCapacity(async () => true, {
        pool: "verified",
        credential: randomUUID(),
      });
      expect(await isPending(queued)).toBe(true);
    } finally {
      release();
      await Promise.all([...pending, ...verified]);
    }
    await expect(queued).resolves.toBe(true);
    for (const pool of ["unverified", "verified"] as const) {
      await expect(
        withMcpGatewayAuthenticationCapacity(
          async () => {
            throw new Error("Validation failed");
          },
          pool === "verified"
            ? { pool, credential: "throwing-credential" }
            : { pool },
        ),
      ).rejects.toThrow("Validation failed");
      const resumed = Array.from({ length: 16 }, () =>
        withMcpGatewayAuthenticationCapacity(
          async () => true,
          pool === "verified" ? { pool, credential: randomUUID() } : { pool },
        ),
      );
      await expect(Promise.all(resumed)).resolves.toHaveLength(16);
    }
  });

  test("overflows one verified credential without consuming other callers' reserved capacity", async () => {
    const admission = { pool: "verified" as const, credential: randomUUID() };
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Four reserved slots plus the sixteen slots shared with unknown callers.
    const pending = Array.from({ length: 20 }, (_, index) =>
      withMcpGatewayAuthenticationCapacity(async () => {
        await held;
        if (index === 0 || index === 4)
          throw new Error("Authentication failed");
        return true;
      }, admission),
    );
    const settled = Promise.allSettled(pending);
    let otherCallers: Promise<void>[] = [];
    const queued: Promise<boolean>[] = [];
    try {
      queued.push(
        withMcpGatewayAuthenticationCapacity(async () => true, admission),
      );
      expect(await isPending(queued[0])).toBe(true);
      await expect(
        withMcpGatewayAuthenticationCapacity(async () => true),
      ).rejects.toBeInstanceOf(McpGatewayAuthenticationBusyError);
      let othersStarted = 0;
      otherCallers = Array.from({ length: 12 }, () =>
        withMcpGatewayAuthenticationCapacity(
          async () => {
            othersStarted += 1;
            await held;
          },
          { pool: "verified", credential: randomUUID() },
        ),
      );
      // Other verified callers get the remaining reserved slots at once.
      expect(othersStarted).toBe(12);
      queued.push(
        withMcpGatewayAuthenticationCapacity(async () => true, {
          pool: "verified",
          credential: randomUUID(),
        }),
      );
      expect(await isPending(queued[1])).toBe(true);
    } finally {
      release();
      await settled;
      await Promise.all(otherCallers);
    }
    await expect(Promise.all(queued)).resolves.toEqual([true, true]);
    expect(
      (await settled).filter((result) => result.status === "rejected"),
    ).toHaveLength(2);
    const resumed = Array.from({ length: 20 }, () =>
      withMcpGatewayAuthenticationCapacity(async () => true, admission),
    );
    await expect(Promise.all(resumed)).resolves.toHaveLength(20);
  });

  test("admits fifty parallel calls with one verified credential without exceeding the pools", async () => {
    const admission = { pool: "verified" as const, credential: randomUUID() };
    let active = 0;
    let peak = 0;
    const calls = Array.from({ length: 50 }, () =>
      withMcpGatewayAuthenticationCapacity(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return true;
      }, admission),
    );
    await expect(Promise.all(calls)).resolves.toHaveLength(50);
    // Four reserved slots plus the sixteen shared with unknown callers.
    expect(peak).toBe(20);
  });

  test("refuses verified callers when the wait ends or the queue is full", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = [
      ...Array.from({ length: 16 }, () =>
        withMcpGatewayAuthenticationCapacity(() => held, {
          pool: "verified",
          credential: randomUUID(),
        }),
      ),
      ...Array.from({ length: 16 }, () =>
        withMcpGatewayAuthenticationCapacity(() => held),
      ),
    ];
    const queue = (credential: string) =>
      withMcpGatewayAuthenticationCapacity(async () => true, {
        pool: "verified",
        credential,
      });
    try {
      const credentials = Array.from({ length: 4 }, () => randomUUID());
      const first = Array.from({ length: 128 }, () => queue(credentials[0]));
      // One credential may have 128 waiting calls; others can still queue.
      await expect(queue(credentials[0])).rejects.toBeInstanceOf(
        McpGatewayAuthenticationBusyError,
      );
      const waiting = Promise.allSettled([
        ...first,
        ...credentials
          .slice(1)
          .flatMap((credential) =>
            Array.from({ length: 128 }, () => queue(credential)),
          ),
      ]);
      // The process holds at most 512 waiting calls in total.
      await expect(queue(randomUUID())).rejects.toBeInstanceOf(
        McpGatewayAuthenticationBusyError,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      const results = await waiting;
      expect(results).toHaveLength(512);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected")
          expect(result.reason).toBeInstanceOf(
            McpGatewayAuthenticationBusyError,
          );
      }
      // Expired waiters leave the queue.
      const next = queue(credentials[0]);
      expect(await isPending(next)).toBe(true);
      release();
      await expect(next).resolves.toBe(true);
    } finally {
      release();
      await Promise.all(holding);
      vi.useRealTimers();
    }
  });

  test("uses spare unverified slots when the verified pool is full", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = Array.from({ length: 16 }, () =>
      withMcpGatewayAuthenticationCapacity(() => held, {
        pool: "verified",
        credential: randomUUID(),
      }),
    );
    try {
      await expect(
        withMcpGatewayAuthenticationCapacity(async () => true, {
          pool: "verified",
          credential: randomUUID(),
        }),
      ).resolves.toBe(true);
    } finally {
      release();
      await Promise.all(pending);
    }
  });

  test("does not admit an unknown caller when shared storage is unavailable", async () => {
    cacheManager.shutdown();
    await expect(
      new McpGatewayRateLimiter().consume("192.0.2.4", 1, {
        credential: randomUUID(),
        gateway: randomUUID(),
      }),
    ).rejects.toThrow("Not started");
  });
  test("renews active credential exemptions while unrelated guesses arrive", async () => {
    const limiter = new McpGatewayRateLimiter();
    const caller = { credential: randomUUID(), gateway: randomUUID() };
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await limiter.consume("192.0.2.5", 1, caller);
      await limiter.recordSuccess(caller);
      clock.mockReturnValue(now + 59_000);
      await limiter.consume("192.0.2.5", 1, caller);
      await limiter.recordSuccess(caller);
      clock.mockReturnValue(now + 60_001);
      for (let i = 0; i < 100; i += 1) {
        await limiter.consume("192.0.2.5", 1, {
          ...caller,
          credential: randomUUID(),
        });
      }
      await expect(
        limiter.consume("192.0.2.5", 1, caller),
      ).resolves.toMatchObject({ consumedPoints: 0 });
      await expect(
        new McpGatewayRateLimiter().consume("192.0.2.5", 1, caller),
      ).resolves.toMatchObject({ consumedPoints: 0 });
    } finally {
      clock.mockRestore();
    }
  });

  test.each([
    "not-deleted",
    "error",
  ])("does not reload a known-denied exemption when shared deletion fails (%s)", async (failure) => {
    const limiter = new McpGatewayRateLimiter();
    const caller = { credential: randomUUID(), gateway: randomUUID() };
    await limiter.consume("192.0.2.6", 1, caller);
    await limiter.recordSuccess(caller);
    for (let i = 0; i < 99; i += 1) {
      await limiter.consume("192.0.2.6", 1, {
        ...caller,
        credential: randomUUID(),
      });
    }
    // Leave the positive row intact, as a failed best-effort deletion does.
    const deletion = vi
      .spyOn(cacheManager, "delete")
      .mockImplementationOnce(async () => {
        if (failure === "error") throw new Error("Storage unavailable");
        return false;
      });
    try {
      await limiter.recordDenial(caller);
      await expect(
        limiter.consume("192.0.2.6", 1, caller),
      ).resolves.toMatchObject({ consumedPoints: 2 });
      for (let i = 0; i < 8; i += 1)
        await limiter.consume("192.0.2.6", 1, caller);
      await expect(
        limiter.consume("192.0.2.6", 1, caller),
      ).rejects.toBeInstanceOf(RateLimiterRes);
    } finally {
      deletion.mockRestore();
    }
  });
});

async function isPending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  return !settled;
}
