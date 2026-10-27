import assert from "node:assert/strict";

export function aggregateSessionUsage(rows, prices) {
  const samples = rows.filter((row) => row.kind === "model_response");
  const totals = {
    attempts: samples.length,
    knownUsage: 0,
    unknownUsage: 0,
    input: 0,
    read: 0,
    write: 0,
    ordinary: 0,
    output: 0,
    apiEquivalentCost: 0,
    observedHits: 0,
    fullMisses: 0,
    prefixHitNewSuffix: 0,
  };
  const timeline = [];
  for (const row of samples) {
    const u = row.usage;
    const known =
      row.ok &&
      u &&
      [
        "totalInput",
        "cacheRead",
        "cacheWrite",
        "uncachedInput",
        "output",
      ].every((key) => Number.isFinite(u[key]) && u[key] >= 0);
    if (!known) {
      totals.unknownUsage++;
      timeline.push({ turn: row.turn, observed: false });
      continue;
    }
    assert.ok(
      Math.abs(u.totalInput - u.cacheRead - u.cacheWrite - u.uncachedInput) <
        1e-6,
      "Usage components do not reconcile.",
    );
    totals.knownUsage++;
    totals.input += u.totalInput;
    totals.read += u.cacheRead;
    totals.write += u.cacheWrite;
    totals.ordinary += u.uncachedInput;
    totals.output += u.output;
    const hit = u.cacheRead > 0;
    if (hit) totals.observedHits++;
    else totals.fullMisses++;
    if (hit && u.uncachedInput > 0) totals.prefixHitNewSuffix++;
    const estimate = prices
      ? (u.uncachedInput * prices.input +
          u.cacheRead * prices.read +
          u.cacheWrite * prices.write +
          u.output * prices.output) /
        1e6
      : null;
    if (estimate !== null) totals.apiEquivalentCost += estimate;
    timeline.push({
      turn: row.turn,
      observed: true,
      input: u.totalInput,
      read: u.cacheRead,
      write: u.cacheWrite,
      ordinary: u.uncachedInput,
      output: u.output,
      cacheReadShare: u.totalInput ? u.cacheRead / u.totalInput : null,
      classification: hit
        ? u.uncachedInput > 0
          ? "prefix_hit_new_suffix"
          : "prefix_hit"
        : "full_miss",
      cumulativeInput: totals.input,
      cumulativeRead: totals.read,
      cumulativeWrite: totals.write,
      cumulativeOrdinary: totals.ordinary,
      cumulativeOutput: totals.output,
      cumulativeApiEquivalentCost: prices ? totals.apiEquivalentCost : null,
      apiEquivalentCost: estimate,
      latencyMs: Number.isFinite(row.latencyMs) ? row.latencyMs : null,
      ttftMs: Number.isFinite(row.ttftMs) ? row.ttftMs : null,
    });
  }
  const toolEvents = rows.filter((row) => row.kind === "tool_execution");
  const measuredModelTimes = samples
    .map((row) => row.latencyMs)
    .filter((value) => Number.isFinite(value) && value >= 0);
  const measuredToolTimes = toolEvents
    .map((row) => row.latencyMs)
    .filter((value) => Number.isFinite(value) && value >= 0);
  return {
    ...totals,
    apiEquivalentCost:
      prices && totals.knownUsage ? totals.apiEquivalentCost : null,
    pricingScope: prices
      ? "Metered API-equivalent estimate, not subscription invoice or unknown failed-call usage"
      : "No pricing supplied",
    tokenWeightedCacheReadShare: totals.input
      ? totals.read / totals.input
      : null,
    observedHitFraction: totals.knownUsage
      ? totals.observedHits / totals.knownUsage
      : null,
    toolExecutions: toolEvents.length,
    successfulToolExecutions: toolEvents.filter((row) => row.ok === true)
      .length,
    measuredModelLatencySamples: measuredModelTimes.length,
    totalMeasuredModelLatencyMs: measuredModelTimes.length
      ? measuredModelTimes.reduce((sum, value) => sum + value, 0)
      : null,
    measuredToolLatencySamples: measuredToolTimes.length,
    totalMeasuredToolLatencyMs: measuredToolTimes.length
      ? measuredToolTimes.reduce((sum, value) => sum + value, 0)
      : null,
    remedyEvaluations: rows.filter((row) => row.kind === "remedy_evaluation")
      .length,
    remedyExecutions: rows.filter(
      (row) => row.kind === "remedy_execution" && row.ok === true,
    ).length,
    childEpisodes: rows.filter((row) => row.kind === "child_episode_started")
      .length,
    timeline,
  };
}

export function prefixChange(before, after) {
  const a = Buffer.from(before),
    b = Buffer.from(after);
  let equal = 0;
  while (equal < Math.min(a.length, b.length) && a[equal] === b[equal]) equal++;
  return {
    priorBytes: a.length,
    nextBytes: b.length,
    equalLeadingBytes: equal,
    appendOnly: equal === a.length && b.length >= a.length,
    changedPriorByte: equal < a.length,
    firstChangedOffset: equal < a.length ? equal : null,
  };
}
