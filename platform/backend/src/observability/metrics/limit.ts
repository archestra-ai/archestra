import client from "prom-client";
import { registerProcessLocalCache } from "@/process-local-cache-registry";
import type { Limit } from "@/types/limit";

type LimitRule = Pick<
  Limit,
  | "id"
  | "entityId"
  | "entityType"
  | "limitType"
  | "limitValue"
  | "cleanupInterval"
> & {
  source?: "explicit" | "default_user";
  behavior?: "hard" | "soft";
};

const detailLabels = [
  "limit_id",
  "entity_id",
  "entity_type",
  "limit_kind",
  "behavior",
  "cleanup_interval",
  "source",
] as const;
type DetailLabels = Record<(typeof detailLabels)[number], string>;
const detailMetrics = [
  [
    "llm_limit_last_exceeded_timestamp_seconds",
    "timestamp",
    "Unix timestamp of the most recent known exhausted limit check",
  ],
  [
    "llm_limit_last_exceeded_threshold",
    "threshold",
    "Configured allowance at the most recent known exhausted limit check; units follow limit_kind",
  ],
  [
    "llm_limit_last_exceeded_usage",
    "usage",
    "Recorded usage at the most recent known exhausted limit check; units follow limit_kind",
  ],
] as const;
// Detail series follow configured rules/targets, never callers or requests.
// Forget inactive observations on scrape so deleted rules do not accumulate forever.
const detailRetentionMs = 24 * 60 * 60 * 1000;
const lastExceeded = registerProcessLocalCache(
  new Map<
    string,
    {
      labels: DetailLabels;
      timestamp: number;
      threshold: number;
      usage?: number;
    }
  >(),
);

export function initializeLimitMetrics(): void {
  for (const [name, field, help] of detailMetrics) {
    if (client.register.getSingleMetric(name)) continue;
    new client.Gauge({
      name,
      help,
      labelNames: [...detailLabels],
      collect() {
        this.reset();
        const cutoff = (Date.now() - detailRetentionMs) / 1000;
        for (const [key, event] of lastExceeded) {
          if (event.timestamp < cutoff) {
            lastExceeded.delete(key);
            continue;
          }
          const value = event[field];
          if (value !== undefined) this.set(event.labels, value);
        }
      },
    });
  }
  if (!client.register.getSingleMetric("llm_limit_checks_total")) {
    new client.Counter({
      name: "llm_limit_checks_total",
      help: "LLM limit rule evaluations, not unique requests or threshold crossings",
      labelNames: ["entity_type", "limit_kind", "behavior", "outcome"],
    });
  }
  if (!client.register.getSingleMetric("llm_limit_storage_errors_total")) {
    new client.Counter({
      name: "llm_limit_storage_errors_total",
      help: "Failures reading or recording LLM limit usage",
      labelNames: ["operation"],
    });
  }
}

/** Returns whether this rule rejects the request; detailed observations identify the configured target. */
export function observeLimitCheck(
  rule: LimitRule,
  exceeded: boolean,
  unavailable = false,
  usage?: number,
): boolean {
  const behavior = rule.behavior ?? "hard";
  const blocked = exceeded && behavior === "hard";
  initializeLimitMetrics();
  if (exceeded && !unavailable) {
    const labels: DetailLabels = {
      limit_id: rule.id,
      entity_id: rule.entityId,
      entity_type: rule.entityType,
      limit_kind: rule.limitType.replace("_per_minute", ""),
      behavior,
      cleanup_interval: rule.cleanupInterval ?? "1w",
      source: rule.source ?? "explicit",
    };
    lastExceeded.set(JSON.stringify(labels), {
      labels,
      timestamp: Date.now() / 1000,
      threshold: rule.limitValue,
      ...(Number.isFinite(usage) ? { usage } : {}),
    });
  }
  (
    client.register.getSingleMetric("llm_limit_checks_total") as client.Counter
  )?.inc({
    entity_type: rule.entityType,
    limit_kind: rule.limitType.replace("_per_minute", ""),
    behavior,
    outcome: blocked
      ? "blocked"
      : unavailable
        ? "usage_unavailable"
        : exceeded
          ? "exceeded"
          : "within_limit",
  });
  return blocked;
}

export function reportLimitStorageError(
  operation: "admission" | "settlement" | "cancellation" | "validation",
): void {
  initializeLimitMetrics();
  (
    client.register.getSingleMetric(
      "llm_limit_storage_errors_total",
    ) as client.Counter
  )?.inc({ operation });
}
