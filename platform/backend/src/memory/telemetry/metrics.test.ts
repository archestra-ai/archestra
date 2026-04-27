import client from "prom-client";
import { vi } from "vitest";
import { beforeEach, describe, expect, test } from "@/test";

vi.mock("@/logging", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("memory telemetry metrics", () => {
  beforeEach(() => {
    client.register.clear();
  });

  test("report helpers are safe no-ops before initialization", async () => {
    vi.resetModules();
    const metrics = await import("./metrics");

    expect(() =>
      metrics.reportMemoryCandidates({
        scopeType: "user",
        extractorVersion: "v1",
        policyFlags: [],
      }),
    ).not.toThrow();
    expect(() =>
      metrics.reportMemoryReviewed({
        scopeType: "user",
        outcome: "approved",
        sourceType: "manual",
      }),
    ).not.toThrow();
    expect(() => metrics.reportMemoryCandidateCreated("manual")).not.toThrow();
    expect(() =>
      metrics.reportMemoryScopeViolationBlocked({
        scopeType: "user",
        reason: "untrusted_context",
      }),
    ).not.toThrow();
    expect(() =>
      metrics.reportMemoryScreenDecision({
        decision: "allow",
        reason: "none",
      }),
    ).not.toThrow();
    expect(() =>
      metrics.reportMemoryInjectionBlock("feature_flag_off"),
    ).not.toThrow();
    expect(() =>
      metrics.reportMemoryReviewPolicyBlocked("high_risk_policy_flags"),
    ).not.toThrow();
    expect(() =>
      metrics.reportMemoryTombstoneHit({
        reason: "rejected",
        matchType: "normalized",
      }),
    ).not.toThrow();
    expect(() =>
      metrics.reportMemorySafetyBlock({
        sourceType: "chat",
        reason: "sensitive",
      }),
    ).not.toThrow();
    expect(() =>
      metrics.reportMemoryDedupDrop({
        sourceType: "chat",
        reason: "idempotency_key",
      }),
    ).not.toThrow();
  });

  test("initializes and records metric values", async () => {
    vi.resetModules();
    const metrics = await import("./metrics");

    metrics.initializeMemoryMetrics();
    metrics.reportMemoryCandidates({
      scopeType: "user",
      extractorVersion: "v1",
      policyFlags: ["instruction_like"],
    });
    metrics.reportMemoryReviewed({
      scopeType: "user",
      outcome: "rejected",
      rejectionReason: "sensitive",
      sourceType: "chat",
    });
    metrics.reportMemoryCandidateCreated("manual");
    metrics.reportMemoryExtractionDuration({
      scopeType: "user",
      outcome: "success",
      durationSeconds: 0.42,
    });
    metrics.reportMemoryPolicyBlocked("external_context");
    metrics.reportMemoryExtractionUnavailable("missing_model");
    metrics.reportMemoryInjectionTokens({
      scopeType: "user",
      tokensApprox: 128,
    });
    metrics.reportMemoryScopeViolationBlocked({
      scopeType: "user",
      reason: "untrusted_context",
    });
    metrics.reportMemoryScreenDecision({
      decision: "flag",
      reason: "instruction_like_medium",
    });
    metrics.reportMemoryInjectionBlock("external_tools_with_trusted_context");
    metrics.reportMemoryReviewPolicyBlocked("high_risk_policy_flags");
    metrics.reportMemoryTombstoneHit({
      reason: "rejected",
      matchType: "legacy_exact",
    });
    metrics.reportMemoryMcpProposeBlock("tombstone_hit");
    metrics.reportMemorySafetyBlock({
      sourceType: "mcp_tool",
      reason: "external_context",
    });
    metrics.reportMemoryDedupDrop({
      sourceType: "chat",
      reason: "content_hash_collision",
    });

    const candidatesMetric = client.register.getSingleMetric(
      "archestra_memory_candidates_total",
    );
    const reviewedMetric = client.register.getSingleMetric(
      "archestra_memory_reviewed_total",
    );
    const extractionDuration = client.register.getSingleMetric(
      "archestra_memory_extraction_duration_seconds",
    );
    const scopeViolationMetric = client.register.getSingleMetric(
      "archestra_memory_scope_violation_blocked_total",
    );
    const screenDecisionMetric = client.register.getSingleMetric(
      "archestra_memory_screen_decision_total",
    );
    const injectionBlockMetric = client.register.getSingleMetric(
      "archestra_memory_injection_block_total",
    );
    const reviewPolicyBlockMetric = client.register.getSingleMetric(
      "archestra_memory_review_policy_block_total",
    );
    const tombstoneHitMetric = client.register.getSingleMetric(
      "archestra_memory_tombstone_hit_total",
    );
    const mcpProposeBlockMetric = client.register.getSingleMetric(
      "archestra_memory_mcp_propose_block_total",
    );
    const candidatesBySourceMetric = client.register.getSingleMetric(
      "archestra_memory_candidates_created_total",
    );
    const reviewBySourceMetric = client.register.getSingleMetric(
      "archestra_memory_review_outcome_total",
    );
    const safetyBlockBySourceMetric = client.register.getSingleMetric(
      "archestra_memory_safety_block_total",
    );
    const dedupDropBySourceMetric = client.register.getSingleMetric(
      "archestra_memory_dedup_drop_total",
    );

    expect(candidatesMetric).toBeDefined();
    expect(reviewedMetric).toBeDefined();
    expect(extractionDuration).toBeDefined();
    expect(scopeViolationMetric).toBeDefined();
    expect(screenDecisionMetric).toBeDefined();
    expect(injectionBlockMetric).toBeDefined();
    expect(reviewPolicyBlockMetric).toBeDefined();
    expect(tombstoneHitMetric).toBeDefined();
    expect(mcpProposeBlockMetric).toBeDefined();
    expect(candidatesBySourceMetric).toBeDefined();
    expect(reviewBySourceMetric).toBeDefined();
    expect(safetyBlockBySourceMetric).toBeDefined();
    expect(dedupDropBySourceMetric).toBeDefined();

    const candidatesValues = await candidatesMetric?.get();
    const reviewedValues = await reviewedMetric?.get();
    const scopeViolationValues = await scopeViolationMetric?.get();
    const screenDecisionValues = await screenDecisionMetric?.get();
    const injectionBlockValues = await injectionBlockMetric?.get();
    const reviewPolicyBlockValues = await reviewPolicyBlockMetric?.get();
    const tombstoneHitValues = await tombstoneHitMetric?.get();
    const mcpProposeBlockValues = await mcpProposeBlockMetric?.get();
    const candidatesBySourceValues = await candidatesBySourceMetric?.get();
    const reviewBySourceValues = await reviewBySourceMetric?.get();
    const safetyBlockBySourceValues = await safetyBlockBySourceMetric?.get();
    const dedupDropBySourceValues = await dedupDropBySourceMetric?.get();

    expect(candidatesValues?.values.some((value) => value.value === 1)).toBe(
      true,
    );
    expect(reviewedValues?.values.some((value) => value.value === 1)).toBe(
      true,
    );
    expect(
      scopeViolationValues?.values.some((value) => value.value === 1),
    ).toBe(true);
    expect(
      screenDecisionValues?.values.some((value) => value.value === 1),
    ).toBe(true);
    expect(
      injectionBlockValues?.values.some((value) => value.value === 1),
    ).toBe(true);
    expect(
      reviewPolicyBlockValues?.values.some((value) => value.value === 1),
    ).toBe(true);
    expect(tombstoneHitValues?.values.some((value) => value.value === 1)).toBe(
      true,
    );
    expect(
      mcpProposeBlockValues?.values.some((value) => value.value === 1),
    ).toBe(true);
    expect(
      candidatesBySourceValues?.values.some((value) => value.value === 1),
    ).toBe(true);
    expect(
      reviewBySourceValues?.values.some((value) => value.value === 1),
    ).toBe(true);
    expect(
      safetyBlockBySourceValues?.values.some((value) => value.value === 1),
    ).toBe(true);
    expect(
      dedupDropBySourceValues?.values.some((value) => value.value === 1),
    ).toBe(true);
  });
});
