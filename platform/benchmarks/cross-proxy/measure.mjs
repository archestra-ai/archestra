import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import http from "node:http";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { measureRequest, summarize } from "../measure.mjs";

const [target, repeat, key] = process.argv.slice(2);
assert.ok(["archestra", "litellm", "direct"].includes(target));
const output = "benchmarks/results/cross-proxy";
const url =
  target === "archestra"
    ? "http://127.0.0.1:19000/v1/openai/chat/completions"
    : target === "litellm"
      ? "http://127.0.0.1:19400/v1/chat/completions"
      : "http://127.0.0.1:19092/v1/chat/completions";
const headers =
  target === "archestra"
    ? {
        authorization: "Bearer benchmark-no-inference",
        "x-archestra-virtual-key": key,
      }
    : target === "litellm"
      ? { authorization: `Bearer ${key}` }
      : {};
const bodyFor = (id, stream) => ({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Reply with the benchmark marker." }],
  max_tokens: 32,
  user: id,
  ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
});
// Exercise real auth before any measured load; a missing key must be rejected.
if (target !== "direct") {
  const bad = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(target === "archestra"
        ? {
            authorization: "Bearer benchmark-no-inference",
            "x-archestra-virtual-key": "invalid-key",
          }
        : { authorization: "Bearer invalid-key" }),
    },
    body: JSON.stringify(bodyFor("invalid-auth", false)),
  });
  assert.ok([401, 403].includes(bad.status), `Auth bypass: ${bad.status}`);
}
const probe = await fetch(url, {
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify(bodyFor(`${target}-${repeat}-probe`, false)),
});
const probeBody = await probe.json();
assert.equal(probe.status, 200, JSON.stringify(probeBody).slice(0, 500));
assert.equal(probeBody.choices[0].message.content, "archestra-benchmark-ok");
assert.deepEqual(probeBody.usage, {
  prompt_tokens: 12,
  completion_tokens: 20,
  total_tokens: 32,
});
// Establish that real accounting/prompt storage works before taking numbers.
if (target !== "direct") {
  const query =
    target === "archestra"
      ? "SELECT count(*) FROM interactions WHERE input_tokens=12 AND output_tokens=20 AND response::text LIKE '%archestra-benchmark-ok%'"
      : `SELECT count(*) FROM "LiteLLM_SpendLogs" WHERE prompt_tokens=12 AND completion_tokens=20 AND response::text LIKE '%archestra-benchmark-ok%'`;
  let persisted = false;
  for (let i = 0; i < 60; i++) {
    const n = Number(
      execFileSync(
        "docker",
        [
          "exec",
          "archestra-cross-proxy-db",
          "psql",
          "-U",
          "benchmark",
          "-d",
          target === "archestra" ? "benchmark" : "litellm",
          "-Atc",
          query,
        ],
        { encoding: "utf8" },
      ).trim(),
    );
    if (n >= (Number(repeat) - 1) * 13401 + 1) {
      persisted = true;
      break;
    }
    await sleep(1000);
  }
  assert.ok(persisted, "Pre-measurement accounting probe did not persist");
}
const blocks = [];
for (const streaming of [false, true]) {
  const concurrency = 50;
  const count = streaming ? 3000 : 10000;
  const agent = new http.Agent({
    keepAlive: true,
    maxSockets: concurrency,
    maxFreeSockets: concurrency,
  });
  const samples = [];
  async function load(n, warmup) {
    let next = 0;
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < n) {
          const index = next++;
          const id = `${target}-${repeat}-${streaming ? "stream" : "chat"}-${warmup ? "warm" : "measured"}-${index}`;
          const sample = await measureRequest({
            url,
            body: bodyFor(id, streaming),
            headers,
            agent,
            expectedContent:
              "archestra-benchmark-ok" + (streaming ? ".".repeat(19) : ""),
            requireGatewayTiming: target === "archestra" && !streaming,
            timeoutMs: 30000,
          });
          if (!warmup) samples.push({ id, ...sample });
          if (!sample.ok) {
            if (warmup) throw new Error(`${id}: ${sample.error}`);
            next = n;
          }
          if (streaming && sample.ok) assert.equal(sample.contentEvents, 20);
        }
      }),
    );
  }
  try {
    await load(200, true);
    const start = performance.now();
    await load(count, false);
    const elapsedMs = performance.now() - start;
    const upstream = await fetch("http://127.0.0.1:19092/samples").then((r) =>
      r.json(),
    );
    const byId = new Map();
    for (const s of upstream) {
      assert.ok(!byId.has(s.id), `Duplicate upstream attempt: ${s.id}`);
      byId.set(s.id, s);
    }
    for (const s of samples) {
      if (!s.ok) continue;
      const u = byId.get(s.id);
      assert.ok(u, `Missing per-request upstream evidence ${s.id}`);
      assert.equal(u.model, "gpt-4o-mini");
      assert.deepEqual(u.messages, bodyFor(s.id, streaming).messages);
      assert.equal(u.max_tokens, 32);
      assert.equal(u.stream, streaming);
      s.upstream = u;
      s.clientAddedMs = s.totalMs - u.durationMs;
      s.firstContentAddedMs =
        s.firstContentMs === null ? null : s.firstContentMs - u.firstContentMs;
    }
    const block = {
      target,
      repeat: Number(repeat),
      streaming,
      concurrency,
      count,
      warmup: 200,
      elapsedMs,
      requestsPerSecond: count / (elapsedMs / 1000),
      errors: samples.filter((s) => !s.ok).length,
      totalMs: summarize(samples.map((s) => s.totalMs)),
      clientAddedMs: summarize(samples.map((s) => s.clientAddedMs)),
      firstContentMs: streaming
        ? summarize(samples.map((s) => s.firstContentMs))
        : null,
      firstContentAddedMs: streaming
        ? summarize(samples.map((s) => s.firstContentAddedMs))
        : null,
      gatewayOverheadMs:
        target === "archestra" && !streaming
          ? summarize(samples.map((s) => s.gatewayTiming.overheadMs))
          : null,
      samples,
    };
    blocks.push(block);
    await writeFile(
      `${output}/${target}-${repeat}.json`,
      JSON.stringify({ probeUsage: probeBody.usage, blocks }, null, 2),
    );
    console.info(JSON.stringify({ ...block, samples: undefined }));
    assert.equal(block.errors, 0, "Measured errors; partial raw results saved");
  } finally {
    agent.destroy();
  }
}
