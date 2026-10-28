import client from "prom-client";
import type { Limit } from "@/types/limit";

type LimitRule = Pick<Limit, "entityType" | "limitType"> & {
  behavior?: "hard" | "soft";
};

export function initializeLimitMetrics(): void {
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

/** Returns whether this rule rejects the request. Never labels metrics with identities. */
export function observeLimitCheck(
  rule: LimitRule,
  exceeded: boolean,
  unavailable = false,
): boolean {
  const behavior = rule.behavior ?? "hard";
  const blocked = exceeded && behavior === "hard";
  initializeLimitMetrics();
  (
    client.register.getSingleMetric("llm_limit_checks_total") as client.Counter
  )?.inc({
    entity_type: rule.entityType,
    limit_kind: rule.limitType.replace("_per_minute", ""),
    behavior,
    outcome: unavailable
      ? "usage_unavailable"
      : blocked
        ? "blocked"
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
