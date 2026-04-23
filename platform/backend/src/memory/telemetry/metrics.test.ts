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
      }),
    ).not.toThrow();
    expect(() =>
      metrics.reportMemoryScopeViolationBlocked({
        scopeType: "user",
        reason: "untrusted_context",
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
    });
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

    expect(candidatesMetric).toBeDefined();
    expect(reviewedMetric).toBeDefined();
    expect(extractionDuration).toBeDefined();
    expect(scopeViolationMetric).toBeDefined();

    const candidatesValues = await candidatesMetric?.get();
    const reviewedValues = await reviewedMetric?.get();
    const scopeViolationValues = await scopeViolationMetric?.get();

    expect(candidatesValues?.values.some((value) => value.value === 1)).toBe(
      true,
    );
    expect(reviewedValues?.values.some((value) => value.value === 1)).toBe(
      true,
    );
    expect(
      scopeViolationValues?.values.some((value) => value.value === 1),
    ).toBe(true);
  });
});
