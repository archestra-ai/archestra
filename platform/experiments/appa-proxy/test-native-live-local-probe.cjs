"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { delimiter, join } = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const platformNodeModules = join(__dirname, "../../backend/node_modules");
const FIXTURE = join(__dirname, "native-live-fixture-sdk.cjs");
const PROBE = join(__dirname, "native-live-local-probe.cjs");
const LOCAL_EFFECT = "SYNTHETIC_LOCAL_PUBLIC_EFFECT";
const LOCAL_PROBE = "fixed-node-local-probe/v1";

test("fixed local probe produces a capability-scoped independently observed callback effect", async (t) => {
  const fixture = await startFixture(t);
  const run = await createRun(fixture, "run-local-probe-normal");
  const unauthorized = await fetch(new URL("/observer/local-effect", fixture.base), {
    method: "POST",
    headers: { authorization: "Bearer invalid-run-capability", "content-type": "application/json" },
    body: JSON.stringify({
      run_id: "run-local-probe-normal",
      request_key: "synthetic-unauthorized",
      effect: LOCAL_EFFECT,
      probe: LOCAL_PROBE,
    }),
  });
  assert.equal(unauthorized.status, 401);
  const malformed = await fetch(new URL("/observer/local-effect", fixture.base), {
    method: "POST",
    headers: { authorization: `Bearer ${run.local_callback_capability}`, "content-type": "application/json" },
    body: JSON.stringify({ run_id: "run-local-probe-normal", request_key: "synthetic-extra", effect: LOCAL_EFFECT, probe: LOCAL_PROBE, command: "not-accepted" }),
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual((await observer(fixture, "run-local-probe-normal")).effect_counts, {
    local_callback: 0,
    mcp_publication: 0,
  });

  const probe = await runProbe({
    observerUrl: new URL("/observer/local-effect", fixture.base),
    capability: run.local_callback_capability,
    runId: "run-local-probe-normal",
    requestKey: "synthetic-local-allowed",
  });
  assert.equal(probe.code, 0);
  assert.deepEqual(JSON.parse(probe.stdout), {
    status: "effect_submitted",
    run_id: "run-local-probe-normal",
    request_key: "synthetic-local-allowed",
  });
  assert.equal(probe.stdout.includes(run.local_callback_capability), false);

  const evidence = await observer(fixture, "run-local-probe-normal");
  assert.deepEqual(evidence.effect_counts, { local_callback: 1, mcp_publication: 0 });
  assert.equal(evidence.call_bindings.length, 1);
  const [binding] = evidence.call_bindings;
  assert.equal(binding.tool_name, "local_callback");
  assert.match(binding.arguments_sha256, /^[0-9a-f]{64}$/);
  assert.match(binding.source_host_sha256, /^[0-9a-f]{64}$/);
  assert.equal(binding.service_instance_id, evidence.service_instance_id);
  assert.equal(binding.effect_state, "known_committed");
  assert.equal(binding.reply_state, "known");
  assert.ok(binding.invocation_sequence < binding.effect_committed_sequence);
  assert.ok(binding.effect_committed_sequence < binding.result_sequence);
  assert.ok(evidence.capabilities.includes("run_scoped_local_callback_capability"));
  assert.ok(evidence.capabilities.includes("zero_effect_counts"));
});

test("operator-selected reply drop records a known effect and unknown caller reply", async (t) => {
  const fixture = await startFixture(t);
  const run = await createRun(fixture, "run-local-probe-reply-drop", { post_commit_reply_drop: "local_callback" });
  const probe = await runProbe({
    observerUrl: new URL("/observer/local-effect", fixture.base),
    capability: run.local_callback_capability,
    runId: "run-local-probe-reply-drop",
    requestKey: "synthetic-local-reply-drop",
  });
  assert.equal(probe.code, 1);
  assert.equal(JSON.parse(probe.stdout).status, "reply_unknown_or_submission_failed");

  const evidence = await observer(fixture, "run-local-probe-reply-drop");
  assert.equal(evidence.effect_counts.local_callback, 1);
  assert.equal(evidence.call_bindings.length, 1);
  const [binding] = evidence.call_bindings;
  assert.deepEqual(
    { effect_state: binding.effect_state, reply_state: binding.reply_state, result_status: binding.result_status },
    { effect_state: "known_committed", reply_state: "unknown", result_status: "result_reply_dropped" },
  );
  assert.ok(binding.effect_committed_sequence < binding.result_sequence);
});

async function startFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "appa-native-local-probe-"));
  const port = 20000 + Math.floor(Math.random() * 1000);
  const token = "fixture-token";
  const adminToken = "admin-token";
  const fixtureProcess = spawn(process.execPath, [FIXTURE, "--db", join(directory, "fixture.sqlite"), "--port", String(port)], {
    env: {
      ...process.env,
      NODE_PATH: [platformNodeModules, process.env.NODE_PATH].filter(Boolean).join(delimiter),
      APPA_NATIVE_FIXTURE_TOKEN: token,
      APPA_NATIVE_FIXTURE_ADMIN_TOKEN: adminToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    fixtureProcess.kill("SIGTERM");
    await once(fixtureProcess, "exit");
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.race([
    once(fixtureProcess.stdout, "data"),
    once(fixtureProcess, "exit").then(([code]) => {
      throw new Error(`fixture exited before becoming ready (${code})`);
    }),
  ]);
  return { base: new URL(`http://127.0.0.1:${port}`), adminToken };
}

async function createRun(fixture, runId, controls) {
  const response = await fetch(new URL(`/admin/runs/${runId}`, fixture.base), {
    method: "POST",
    headers: {
      authorization: `Bearer ${fixture.adminToken}`,
      ...(controls ? { "content-type": "application/json" } : {}),
    },
    ...(controls ? { body: JSON.stringify(controls) } : {}),
  });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.match(body.local_callback_capability, /^[0-9a-f]{64}$/);
  return body;
}

async function observer(fixture, runId) {
  const response = await fetch(new URL(`/admin/runs/${runId}/observer`, fixture.base), {
    headers: { authorization: `Bearer ${fixture.adminToken}` },
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function runProbe({ observerUrl, capability, runId, requestKey }) {
  const child = spawn(process.execPath, [PROBE], {
    env: {
      ...process.env,
      APPA_NATIVE_LOCAL_PROBE_OBSERVER_URL: observerUrl.toString(),
      APPA_NATIVE_LOCAL_CALLBACK_CAPABILITY: capability,
      APPA_NATIVE_LOCAL_PROBE_RUN_ID: runId,
      APPA_NATIVE_LOCAL_PROBE_REQUEST_KEY: requestKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  await once(child, "exit");
  return { code: child.exitCode, stdout: Buffer.concat(stdout).toString("utf8") };
}
