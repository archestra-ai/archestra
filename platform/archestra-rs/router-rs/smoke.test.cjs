"use strict";

const assert = require("node:assert/strict");
const routerRs = require("./index.cjs");

// plan resolves off-thread to a Plan JSON that decide accepts; invalid input
// rejects with a coded error. Numerical correctness lives in the router_core
// cargo tests.
const DAY_MS = 24 * 60 * 60 * 1000;
const prices = (input) => ({
  input,
  cache_read: input / 10,
  cache_write: input * 1.25,
  output: input * 5,
});
const features = {
  tier_needed: [0.5, 0.25, 0.25],
  p_long: 0,
  source: "main",
};
const planInput = {
  history: Array.from({ length: 40 }, (_, i) => ({
    features,
    short: {
      input: 1_000 + 37 * i,
      cache_read: 20_000 + 101 * i,
      cache_write: 2_000,
      output: 500 + 11 * i,
    },
    long: { input: 0, cache_read: 0, cache_write: 0, output: 0 },
    timestamp_ms: i * DAY_MS,
    weight: 1,
  })),
  tiers: {
    tiers: [
      { model_id: "fast", short: prices(1), long: prices(5) },
      { model_id: "normal", short: prices(3), long: null },
      { model_id: "smart", short: prices(15), long: null },
    ],
    long_context_threshold: 100_000,
  },
  budget: 4,
  volume: { kind: "flat", sessions_per_day: 40, tokens_per_day: 1e6 },
  baseline_source: "main",
};

(async () => {
  const planJson = await routerRs.plan(JSON.stringify(planInput));
  assert.equal(typeof planJson, "string");
  assert.equal(typeof JSON.parse(planJson).policy.q, "number");
  assert.equal(
    JSON.parse(planJson).versions.core_version,
    routerRs.coreVersion(),
  );
  assert.equal(
    JSON.parse(planJson).versions.plan_format_version,
    routerRs.planFormatVersion(),
  );

  const policyJson = JSON.stringify(JSON.parse(planJson).policy);
  for (const u of [0.1, 0.9]) {
    const decision = JSON.parse(
      routerRs.decide(planJson, policyJson, JSON.stringify(features), u),
    );
    assert.ok([0, 1, 2].includes(decision.tier_index));
    assert.ok(decision.propensity > 0 && decision.propensity <= 1);
    assert.equal(decision.lambda, JSON.parse(policyJson).lam_star);
    assert.ok(decision.expected_cost_usd > 0);
  }

  const [assessed] = JSON.parse(
    routerRs.assess(planJson, JSON.stringify([features])),
  );
  assert.equal(assessed.usd_per_token.length, 3);
  assert.ok(assessed.predicted_tokens > 0);
  assert.throws(() => routerRs.assess(planJson, JSON.stringify(features)), {
    code: "ARCHESTRA_ROUTER_INVALID_INPUT",
  });

  await assert.rejects(
    routerRs.plan(JSON.stringify({ ...planInput, budget: -1 })),
    { code: "ARCHESTRA_ROUTER_INVALID_INPUT" },
  );
  await assert.rejects(routerRs.plan(JSON.stringify({ ...planInput, budget: 0.01 })), {
    code: "ARCHESTRA_ROUTER_INFEASIBLE",
  });
  assert.throws(
    () => routerRs.decide(planJson, policyJson, JSON.stringify(features), 1),
    { code: "ARCHESTRA_ROUTER_INVALID_UNIFORM" },
  );
  assert.throws(
    () => routerRs.decide("not json", policyJson, JSON.stringify(features), 0.5),
    { code: "ARCHESTRA_ROUTER_INVALID_PLAN" },
  );
  assert.throws(
    () =>
      routerRs.decide(
        planJson,
        JSON.stringify({ lam_star: -1, q: 0 }),
        JSON.stringify(features),
        0.5,
      ),
    { code: "ARCHESTRA_ROUTER_INVALID_POLICY" },
  );

  console.log("router-rs smoke ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
