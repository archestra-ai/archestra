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
      await expect(
        withMcpGatewayAuthenticationCapacity(async () => true, {
          pool: "verified",
          credential: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(McpGatewayAuthenticationBusyError);
    } finally {
      release();
      await Promise.all([...pending, ...verified]);
    }
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

  test("caps a verified credential and releases its permits after success and failure", async () => {
    const admission = { pool: "verified" as const, credential: randomUUID() };
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = Array.from({ length: 4 }, (_, index) =>
      withMcpGatewayAuthenticationCapacity(async () => {
        await held;
        if (index === 0) throw new Error("Authentication failed");
        return true;
      }, admission),
    );
    const settled = Promise.allSettled(pending);
    try {
      await expect(
        withMcpGatewayAuthenticationCapacity(async () => true, admission),
      ).rejects.toBeInstanceOf(McpGatewayAuthenticationBusyError);
      await expect(
        withMcpGatewayAuthenticationCapacity(async () => true, {
          pool: "verified",
          credential: randomUUID(),
        }),
      ).resolves.toBe(true);
    } finally {
      release();
      await settled;
    }
    expect(
      (await settled).filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const resumed = Array.from({ length: 4 }, () =>
      withMcpGatewayAuthenticationCapacity(async () => true, admission),
    );
    await expect(
      withMcpGatewayAuthenticationCapacity(async () => true, admission),
    ).rejects.toBeInstanceOf(McpGatewayAuthenticationBusyError);
    await expect(Promise.all(resumed)).resolves.toHaveLength(4);
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
