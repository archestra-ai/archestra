import assert from "node:assert/strict";

export async function openProviderEvidence({ base, fetchImpl = fetch }) {
  const origin = new URL(base);
  assert.ok(
    origin.protocol === "http:" &&
      ["127.0.0.1", "[::1]"].includes(origin.hostname),
  );
  assert.ok(
    origin.pathname === "/" &&
      !origin.username &&
      !origin.password &&
      !origin.search &&
      !origin.hash,
  );
  const fence = async (after) => {
    const response = await fetchImpl(`${origin.origin}/fence?after=${after}`, {
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    assert.ok(response.ok, "provider_capture_fence_failed");
    const result = await response.json();
    assert.ok(
      result.mode === "live" &&
        result.active === 0 &&
        Number.isSafeInteger(result.lastIdx),
    );
    return result;
  };
  const before = await fence(0);
  return async ({ namespace, observations, measurements }) => {
    const after = await fence(before.lastIdx);
    assert.ok(after.lastIdx >= before.lastIdx);
    assert.ok(
      after.oldestIdx === null || after.oldestIdx <= before.lastIdx + 1,
      "provider_capture_retention_gap",
    );
    const interval = after.records.filter(
      (entry) => entry.idx > before.lastIdx,
    );
    assert.equal(
      interval.length,
      after.lastIdx - before.lastIdx,
      "provider_capture_record_gap",
    );
    const rows = interval.filter((entry) => entry.sessionId === namespace);
    const roles = new Map();
    for (const entry of observations) {
      if (!entry.responseMessageHash) continue;
      assert.ok(
        !roles.has(entry.responseMessageHash),
        "duplicate_client_response_id",
      );
      roles.set(entry.responseMessageHash, entry.role);
    }
    const attempts = rows.map((entry) => {
      const usage = entry.upstreamUsage;
      const responseMessageHash = usage?.responseMessageHash ?? null;
      const role = roles.get(responseMessageHash) ?? "unknown";
      const durationMs = entry.timingsMs?.total;
      assert.ok(
        Number.isFinite(durationMs) && durationMs >= 0,
        "missing_provider_duration",
      );
      const status =
        entry.upstreamStreamError || usage?.modelFailed || entry.status >= 400
          ? "failed"
          : usage?.terminalObserved === true
            ? "complete"
            : entry.error === "client_disconnected"
              ? "cancelled"
              : "failed";
      measurements.recordProviderAttempt({
        role,
        durationMs,
        httpStatus: entry.status,
        status,
        requestHash: entry.requestHash,
      });
      return {
        role,
        durationMs,
        status,
        httpStatus: entry.status,
        requestHash: entry.requestHash,
        responseMessageHash,
        model: usage?.model ?? null,
        counters: usage?.counters ?? null,
        counterConflictFields: usage?.counterConflictFields ?? [],
        terminalObserved: usage?.terminalObserved ?? false,
        usageError: entry.upstreamUsageError !== null,
      };
    });
    const clientIds = new Set(
      observations.map((entry) => entry.responseMessageHash).filter(Boolean),
    );
    const providerIds = new Set(
      attempts.map((entry) => entry.responseMessageHash).filter(Boolean),
    );
    const matchedClientResponses = [...clientIds].filter((id) =>
      providerIds.has(id),
    ).length;
    const unscopedAttempts = interval.filter(
      (entry) => !entry.sessionId,
    ).length;
    const complete =
      rows.length > 0 &&
      matchedClientResponses === clientIds.size &&
      clientIds.size > 0 &&
      unscopedAttempts === 0;
    if (complete) measurements.finishProviderEvidence();
    return {
      complete,
      matchedClientResponses,
      clientResponses: clientIds.size,
      unscopedAttempts,
      foreignScopedAttempts: interval.length - rows.length - unscopedAttempts,
      attempts,
    };
  };
}
