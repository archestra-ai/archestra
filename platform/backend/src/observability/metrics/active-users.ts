import client from "prom-client";
import config from "@/config";
import logger from "@/logging";
import InteractionModel from "@/models/interaction";

/**
 * Org-wide AI adoption signal: how many distinct people used the LLM proxy
 * recently.
 *
 * This metric is deliberately an aggregate with NO per-user label. Prometheus
 * series count is the product of a metric's label values, so a `user_id` label
 * would multiply every series by the size of the organization and leave a stale
 * series behind for every departed user. (The same reasoning already keeps
 * `external_agent_id` off the LLM metrics.) The `window` label is bounded to
 * the two values below.
 *
 * Per-user detail is served by the statistics API instead, which reads
 * Postgres — the source of truth, and the only store that can answer exact
 * per-person questions over months.
 *
 * The value is derived from the shared database, so every replica computes the
 * same number. Aggregate across replicas with `max()` (not `sum()`), which
 * would multiply by the replica count.
 */

const ACTIVE_USER_WINDOWS = [
  { label: "24h", ms: 24 * 60 * 60 * 1000 },
  { label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
] as const;

let activeUsersGauge: client.Gauge<string> | undefined;

export function initializeActiveUsersMetrics(): void {
  try {
    if (activeUsersGauge) {
      client.register.removeSingleMetric("llm_active_users");
    }
  } catch (_error) {
    // Ignore errors if the metric does not exist yet
  }

  activeUsersGauge = new client.Gauge({
    name: "llm_active_users",
    help: "Distinct users with at least one attributed LLM request in the window. Aggregate across replicas with max(), not sum().",
    labelNames: ["window"],
  });
}

/**
 * Periodically refreshes {@link activeUsersGauge} from the database.
 *
 * Polling rather than incrementing on the request path because the metric is a
 * distinct count over a rolling window — a counter cannot express it, and an
 * in-process set would report a different (partial) answer per replica.
 */
class ActiveUsersMetricCollector {
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    const intervalMs =
      config.observability.metrics.activeUsersRefreshIntervalMs;

    if (intervalMs <= 0) {
      logger.info(
        "Active-users metric collection disabled (refresh interval is 0)",
      );
      return;
    }

    if (this.timer) {
      return;
    }

    // `unref` so a pending refresh never holds the process open on shutdown.
    this.timer = setInterval(() => {
      void this.refresh();
    }, intervalMs);
    this.timer.unref();

    void this.refresh();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for tests and for the initial population on start. */
  async refresh(): Promise<void> {
    if (!activeUsersGauge) {
      return;
    }

    try {
      const now = Date.now();
      for (const window of ACTIVE_USER_WINDOWS) {
        const activeUsers =
          await InteractionModel.countDistinctActiveUsersSince(
            new Date(now - window.ms),
          );
        activeUsersGauge.set({ window: window.label }, activeUsers);
      }
    } catch (error) {
      // A metrics refresh must never take down the process or interrupt the
      // interval; the gauge simply keeps its previous value until next tick.
      logger.error({ error }, "Failed to refresh active-users metric");
    }
  }
}

export const activeUsersMetricCollector = new ActiveUsersMetricCollector();
