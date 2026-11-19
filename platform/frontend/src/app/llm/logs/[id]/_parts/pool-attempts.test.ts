// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  poolAttemptsOf,
  poolFailureLabel,
  poolFailureText,
  retriesRowAbove,
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
    expect(poolAttemptsOf(failed, requests).attempts.map((r) => r.id)).toEqual([
      "failed",
      "retry",
    ]);
    expect(poolAttemptsOf(retry, requests).attempts.map((r) => r.id)).toEqual([
      "failed",
      "retry",
    ]);
  });

  it("does not join an answered request to the next one", () => {
    expect(poolAttemptsOf(earlier, requests).attempts.map((r) => r.id)).toEqual(
      ["earlier"],
    );
    expect(poolAttemptsOf(later, requests).attempts.map((r) => r.id)).toEqual([
      "later",
    ]);
  });

  it("leaves overlapping requests to one pool unlinked", () => {
    // A1 and B1 fail side by side; either retry could belong to either.
    const overlapping = (
      id: string,
      seconds: number,
      attempt: number,
      outcome: string,
    ) =>
      row({
        id,
        sessionId: "run",
        createdAt: at(seconds * 1000),
        durationMs: 3000,
        modelPoolId: "pool",
        attempt,
        attemptOutcome: outcome as "answered" | "failed_over",
      });
    const rows = [
      overlapping("a1", 10, 1, "failed_over"),
      overlapping("b1", 11, 1, "failed_over"),
      overlapping("b2", 13, 2, "answered"),
      overlapping("a2", 14, 2, "answered"),
    ];
    for (const r of rows) {
      expect(poolAttemptsOf(r, rows).attempts.map((x) => x.id)).toEqual([r.id]);
    }
    expect(retriesRowAbove(rows[2], rows[1], rows)).toBe(false);
  });

  it("joins a retry to its failed attempt only when that is the row above", () => {
    expect(retriesRowAbove(retry, failed, requests)).toBe(true);
    // The client's own request sits between them on a merged trace.
    expect(retriesRowAbove(retry, other, requests)).toBe(false);
  });

  it("is complete only from the first attempt to the one that ended it", () => {
    expect(poolAttemptsOf(retry, requests).complete).toBe(true);
    expect(poolAttemptsOf(earlier, requests).complete).toBe(true);
    // The failed attempt alone: its retry is not loaded.
    expect(poolAttemptsOf(failed, [failed]).complete).toBe(false);
    // The retry alone: its first attempt is not loaded.
    expect(poolAttemptsOf(retry, [retry]).complete).toBe(false);
  });

  it("returns the row alone when its retry is not loaded", () => {
    expect(poolAttemptsOf(failed, [failed]).attempts.map((r) => r.id)).toEqual([
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
