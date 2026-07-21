import client from "prom-client";
import { getPoolStats } from "@/database";
import logger from "@/logging";

type PoolStatsProvider = () => ReturnType<typeof getPoolStats>;

/**
 * Initialize database connection-pool metrics.
 *
 * The pool is sampled at scrape time via the gauge `collect()` callback rather
 * than on a timer, so the series always reflects the live pool state.
 * `database_pool_connections{state="waiting"}` is the load-bearing series:
 * queries queued for a free client are otherwise invisible — individual query
 * spans stay fast while requests stall in checkout.
 */
export function initializeDatabaseMetrics(
  // Injectable for tests; production callers use the live pool counters.
  statsProvider: PoolStatsProvider = getPoolStats,
): void {
  if (initialized) return;

  // The gauges are fully self-driving via collect(); no handles are kept
  // because nothing records to them outside scrape time.
  new client.Gauge({
    name: "database_pool_connections",
    help: "Live pg pool connection counts (total = open clients, idle = unused open clients, waiting = queries queued for a free client)",
    labelNames: ["state"],
    collect() {
      const stats = statsProvider();
      if (!stats) return;
      this.set({ state: "total" }, stats.totalCount);
      this.set({ state: "idle" }, stats.idleCount);
      this.set({ state: "waiting" }, stats.waitingCount);
    },
  });

  new client.Gauge({
    name: "database_pool_size_limit",
    help: "Configured pg pool max size per Node process (ARCHESTRA_DATABASE_POOL_MAX)",
    collect() {
      const stats = statsProvider();
      if (!stats) return;
      this.set(stats.maxSize);
    },
  });

  initialized = true;
  logger.info("Database pool metrics initialized");
}

// ============================================================
// Internal implementation
// ============================================================

let initialized = false;
