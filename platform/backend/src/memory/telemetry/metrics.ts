import client from "prom-client";
import logger from "@/logging";
import type {
  MemoryPolicyFlag,
  MemoryRejectionReason,
  MemoryScopeType,
  MemoryStatus,
} from "@/types/memory-item";

export type MemoryReviewOutcome =
  | "approved"
  | "rejected"
  | "archived"
  | "unarchived";

export type MemoryExtractionOutcome = "success" | "skipped" | "error";

export type MemoryPolicyBlockedReason =
  | "sensitive"
  | "high_risk_pii"
  | "external_context";

export type MemoryExtractionUnavailableReason =
  | "missing_model"
  | "missing_api_key";

let memoryCandidatesTotal: client.Counter<string>;
let memoryReviewedTotal: client.Counter<string>;
let memoryItemsTotal: client.Gauge<string>;
let memoryExtractionDuration: client.Histogram<string>;
let memoryPolicyBlockedTotal: client.Counter<string>;
let memoryExtractionUnavailableTotal: client.Counter<string>;
let memoryInjectionTokens: client.Histogram<string>;
let memoryScopeViolationBlockedTotal: client.Counter<string>;

let initialized = false;

// =============================================================================
// Exported items (public interface)
// =============================================================================

export function initializeMemoryMetrics(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  memoryCandidatesTotal = new client.Counter({
    name: "archestra_memory_candidates_total",
    help: "Total memory candidates proposed by extractor",
    labelNames: ["scope_type", "extractor_version", "policy_flag"],
  });

  memoryReviewedTotal = new client.Counter({
    name: "archestra_memory_reviewed_total",
    help: "Total memory review transitions",
    labelNames: ["scope_type", "outcome", "rejection_reason"],
  });

  memoryItemsTotal = new client.Gauge({
    name: "archestra_memory_items_total",
    help: "Current number of memory items by scope and status",
    labelNames: ["scope_type", "status"],
  });

  memoryExtractionDuration = new client.Histogram({
    name: "archestra_memory_extraction_duration_seconds",
    help: "Memory extraction duration in seconds",
    labelNames: ["scope_type", "outcome"],
    buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60],
  });

  memoryPolicyBlockedTotal = new client.Counter({
    name: "archestra_memory_policy_blocked_total",
    help: "Total memory candidates blocked by policy checks",
    labelNames: ["reason"],
  });

  memoryExtractionUnavailableTotal = new client.Counter({
    name: "archestra_memory_extraction_unavailable_total",
    help: "Total memory extraction attempts skipped due to unavailable model/api key",
    labelNames: ["reason"],
  });

  memoryInjectionTokens = new client.Histogram({
    name: "archestra_memory_injection_tokens",
    help: "Approximate injected memory tokens per request",
    labelNames: ["scope_type"],
    buckets: [0, 50, 100, 200, 400, 600, 800, 1200],
  });

  memoryScopeViolationBlockedTotal = new client.Counter({
    name: "archestra_memory_scope_violation_blocked_total",
    help: "Total memory operations blocked due to scope or trust violations",
    labelNames: ["scope_type", "reason"],
  });

  logger.info("Memory metrics initialized");
}

export function reportMemoryCandidates(params: {
  scopeType: MemoryScopeType;
  extractorVersion: string;
  policyFlags: MemoryPolicyFlag[];
}): void {
  if (!memoryCandidatesTotal) {
    return;
  }

  const policyFlags = normalizePolicyFlags(params.policyFlags);
  for (const policyFlag of policyFlags) {
    memoryCandidatesTotal.inc({
      scope_type: params.scopeType,
      extractor_version: params.extractorVersion,
      policy_flag: policyFlag,
    });
  }
}

export function reportMemoryReviewed(params: {
  scopeType: MemoryScopeType;
  outcome: MemoryReviewOutcome;
  rejectionReason?: MemoryRejectionReason | null;
}): void {
  if (!memoryReviewedTotal) {
    return;
  }

  memoryReviewedTotal.inc({
    scope_type: params.scopeType,
    outcome: params.outcome,
    rejection_reason: params.rejectionReason ?? "none",
  });
}

export function reportMemoryItemsTotal(params: {
  scopeType: MemoryScopeType;
  status: MemoryStatus;
  total: number;
}): void {
  if (!memoryItemsTotal) {
    return;
  }

  memoryItemsTotal.set(
    {
      scope_type: params.scopeType,
      status: params.status,
    },
    params.total,
  );
}

export function reportMemoryExtractionDuration(params: {
  scopeType: MemoryScopeType;
  outcome: MemoryExtractionOutcome;
  durationSeconds: number;
}): void {
  if (!memoryExtractionDuration) {
    return;
  }

  memoryExtractionDuration.observe(
    {
      scope_type: params.scopeType,
      outcome: params.outcome,
    },
    params.durationSeconds,
  );
}

export function reportMemoryPolicyBlocked(
  reason: MemoryPolicyBlockedReason,
): void {
  if (!memoryPolicyBlockedTotal) {
    return;
  }

  memoryPolicyBlockedTotal.inc({ reason });
}

export function reportMemoryExtractionUnavailable(
  reason: MemoryExtractionUnavailableReason,
): void {
  if (!memoryExtractionUnavailableTotal) {
    return;
  }

  memoryExtractionUnavailableTotal.inc({ reason });
}

export function reportMemoryInjectionTokens(params: {
  scopeType: MemoryScopeType;
  tokensApprox: number;
}): void {
  if (!memoryInjectionTokens) {
    return;
  }

  memoryInjectionTokens.observe(
    { scope_type: params.scopeType },
    Math.max(0, params.tokensApprox),
  );
}

export function reportMemoryScopeViolationBlocked(params: {
  scopeType: MemoryScopeType;
  reason: string;
}): void {
  if (!memoryScopeViolationBlockedTotal) {
    return;
  }

  memoryScopeViolationBlockedTotal.inc({
    scope_type: params.scopeType,
    reason: params.reason,
  });
}

// =============================================================================
// Internal helpers
// =============================================================================

function normalizePolicyFlags(policyFlags: MemoryPolicyFlag[]): string[] {
  if (policyFlags.length === 0) {
    return ["none"];
  }

  return Array.from(new Set(policyFlags));
}
