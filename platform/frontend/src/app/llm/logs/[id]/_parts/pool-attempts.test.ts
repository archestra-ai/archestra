// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  poolAttemptsOf,
  poolFailureLabel,
  poolFailureText,
} from "./pool-attempts";
import { at, row } from "./test-records";

describe("poolAttemptsOf", () => {
  const pooled = (
    id: string,
    seconds: number,
    attempt: number,
    outcome: string,
    sessionId = "run",
  ) =>
    row({
      id,
      sessionId,
      createdAt: at(seconds * 1000),
      modelPoolId: "pool",
      attempt,
      attemptOutcome: outcome as "answered" | "failed_over",
    });
  const earlier = pooled("earlier", 1, 1, "answered");
  const failed = pooled("failed", 10, 1, "failed_over");
  // The client's own request, interleaved on a merged trace.
  const other = pooled("other", 10.5, 1, "answered", "client");
  const retry = pooled("retry", 11, 2, "answered");
  const later = pooled("later", 20, 1, "answered");
  const requests = [earlier, failed, other, retry, later];

  it("rebuilds the same chain from either attempt, skipping other sessions' rows", () => {
    expect(poolAttemptsOf(failed, requests).map((r) => r.id)).toEqual([
      "failed",
      "retry",
    ]);
    expect(poolAttemptsOf(retry, requests).map((r) => r.id)).toEqual([
      "failed",
      "retry",
    ]);
  });

  it("does not join an answered request to the next one", () => {
    expect(poolAttemptsOf(earlier, requests).map((r) => r.id)).toEqual([
      "earlier",
    ]);
    expect(poolAttemptsOf(later, requests).map((r) => r.id)).toEqual(["later"]);
  });

  it("returns the row alone when its retry is not loaded", () => {
    expect(poolAttemptsOf(failed, [failed]).map((r) => r.id)).toEqual([
      "failed",
    ]);
  });
});

describe("poolFailureLabel", () => {
  it("reads the proxy's reason and status", () => {
    const failure = poolFailureLabel("rate_limited (429)");
    expect(failure).toEqual({ label: "rate limited", status: 429 });
    expect(failure && poolFailureText(failure)).toBe("429 · rate limited");
    expect(poolFailureLabel("timeout")).toEqual({
      label: "timed out",
      status: null,
    });
  });

  it("keeps an unrecognised reason as written", () => {
    expect(poolFailureLabel("Upstream said no")).toEqual({
      label: "Upstream said no",
      status: null,
    });
    expect(poolFailureLabel(null)).toBeNull();
  });
});
