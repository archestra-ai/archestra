import client from "prom-client";
import { afterEach, beforeEach, describe, expect, test, vi } from "@/test";

describe("database pool metrics", () => {
  beforeEach(() => {
    client.register.clear();
    vi.resetModules();
  });

  afterEach(() => {
    client.register.clear();
    vi.resetModules();
  });

  test("reports live pool counters and the configured max at scrape time", async () => {
    const { initializeDatabaseMetrics } = await import("./database");

    initializeDatabaseMetrics(() => ({
      totalCount: 7,
      idleCount: 4,
      waitingCount: 2,
      maxSize: 20,
    }));

    const metrics = await client.register.metrics();
    expect(metrics).toContain('database_pool_connections{state="total"} 7');
    expect(metrics).toContain('database_pool_connections{state="idle"} 4');
    expect(metrics).toContain('database_pool_connections{state="waiting"} 2');
    expect(metrics).toContain("database_pool_size_limit 20");
  });

  test("emits no per-state samples before the pool is initialized", async () => {
    const { initializeDatabaseMetrics } = await import("./database");

    initializeDatabaseMetrics(() => null);

    const metrics = await client.register.metrics();
    expect(metrics).not.toContain("database_pool_connections{state=");
    // A label-less prom-client gauge always carries a default 0 sample; it
    // stays 0 until the pool exists.
    expect(metrics).toContain("database_pool_size_limit 0");
  });
});
