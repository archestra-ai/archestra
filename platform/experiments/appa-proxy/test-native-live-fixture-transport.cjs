"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const { mkdtemp, rm } = require("node:fs/promises");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { delimiter, join } = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const platformRequire = createRequire(join(__dirname, "../../backend/package.json"));
const platformNodeModules = join(__dirname, "../../backend/node_modules");
const { Client } = platformRequire("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = platformRequire("@modelcontextprotocol/sdk/client/streamableHttp.js");

const FIXTURE = join(__dirname, "native-live-fixture-sdk.cjs");

test("official SDK transport emits authenticated append-only fixture observer records", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "appa-native-live-fixture-"));
  const port = 19000 + Math.floor(Math.random() * 1000);
  const token = "fixture-token";
  const adminToken = "admin-token";
  const fixtureProcess = spawn(process.execPath, [FIXTURE, "--db", join(directory, "fixture.sqlite"), "--port", String(port)], {
    env: {
      ...process.env,
      NODE_PATH: [platformNodeModules, process.env.NODE_PATH]
        .filter(Boolean)
        .join(delimiter),
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
      throw new Error(`official SDK fixture exited before becoming ready (${code})`);
    }),
  ]);
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const unauthorized = await fetch(url);
  assert.equal(unauthorized.status, 401);
  const runId = "run-fixture-observer";
  const created = await fetch(new URL(`/admin/runs/${runId}`, url), {
    method: "POST",
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(created.status, 201);

  const client = new Client({ name: "fixture-transport-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  t.after(() => client.close());
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), ["read_source", "publish", "protected_publish"]);
  assert.deepEqual(tools[0].inputSchema.required, ["run_id", "request_key", "kind"]);
  assert.deepEqual(tools[1].inputSchema.required, ["run_id", "request_key", "value"]);
  await client.callTool({
    name: "read_source",
    arguments: { run_id: runId, request_key: "synthetic-observer-read", kind: "public" },
  });
  await client.callTool({
    name: "publish",
    arguments: { run_id: runId, request_key: "synthetic-observer-write", value: "SYNTHETIC_SERVICE_OK" },
  });

  const observerUrl = new URL(`/admin/runs/${runId}/observer`, url);
  assert.equal((await fetch(observerUrl)).status, 401);
  assert.equal(
    (await fetch(observerUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    })).status,
    404,
  );
  const observer = await fetch(observerUrl, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(observer.status, 200);
  const evidence = await observer.json();
  assert.equal(evidence.source, "trusted-fixture-audit/v1");
  assert.equal(evidence.audit_record_count, 5);
  assert.equal(evidence.call_bindings.length, 2);
  assert.ok(evidence.capabilities.includes("canonical_arguments_sha256"));
  assert.ok(evidence.capabilities.includes("source_host_provenance"));
  assert.ok(evidence.call_bindings.every((binding) => /^[0-9a-f]{64}$/.test(binding.arguments_sha256)));
  assert.ok(evidence.call_bindings.every((binding) => /^[0-9a-f]{64}$/.test(binding.source_host_sha256)));
  assert.ok(evidence.call_bindings.every((binding) => /^[0-9a-f]{64}$/.test(binding.result_sha256)));
  assert.ok(evidence.call_bindings.every((binding) => typeof binding.invocation_id === "string"));
  assert.ok(evidence.call_bindings.every((binding) => binding.service_instance_id === evidence.service_instance_id));
  assert.deepEqual(
    evidence.call_bindings.map((binding) => binding.invocation_sequence),
    [...evidence.call_bindings.map((binding) => binding.invocation_sequence)].sort((left, right) => left - right),
  );
  assert.equal(evidence.call_bindings[0].effect_committed_at, null);
  assert.ok(typeof evidence.call_bindings[1].effect_committed_at === "string");
});
