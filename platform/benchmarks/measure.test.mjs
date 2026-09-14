import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import {
  CompletionReader,
  measureRequest,
  runBlock,
  summarize,
} from "./measure.mjs";
import { createMockServer, MOCK_CONTENT } from "./mock-upstream.mjs";

test("SSE first content ignores comments, role, usage and arbitrary UTF-8 boundaries", () => {
  let events = 0;
  const reader = new CompletionReader({
    streaming: true,
    onContent: () => events++,
  });
  const wire =
    ': keepalive\r\n\r\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\r\n\r\n' +
    'data: {"choices":[{"delta":{"content":"hé"}}]}\n\n' +
    'data: {"choices":[],"usage":{"total_tokens":0}}\n\n' +
    'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n' +
    "data: [DONE]\n\n";
  for (const byte of Buffer.from(wire)) reader.push(Buffer.from([byte]));
  assert.equal(reader.finish(), "héllo");
  assert.equal(events, 2);
});

test("truncated and error streams cannot count as successful requests", () => {
  const truncated = new CompletionReader({ streaming: true });
  truncated.push(Buffer.from('data: {"choices":[]}\n\n'));
  assert.throws(() => truncated.finish(), /Incomplete SSE/);
  const error = new CompletionReader({ streaming: true });
  assert.throws(
    () => error.push(Buffer.from('data: {"error":{"message":"failed"}}\n\n')),
    /SSE error/,
  );
});

test("nearest-rank quantiles include tails without mutating samples", () => {
  const values = [100, ...Array.from({ length: 99 }, (_, i) => i + 1)];
  assert.deepEqual(summarize(values), {
    count: 100,
    mean: 50.5,
    p50: 50,
    p95: 95,
    p99: 99,
    min: 1,
    max: 100,
  });
  assert.equal(values[0], 100);
  assert.equal(summarize([]), null);
});

test("real HTTP streams record content gaps and validate all completed responses", async (t) => {
  const server = createMockServer({ chunks: 3, intervalMs: 2 });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const result = await runBlock({
    url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    body: { model: "mock", stream: true },
    expectedContent: `${MOCK_CONTENT}..`,
    count: 7,
    concurrency: 3,
    warmup: 3,
  });
  assert.equal(result.succeeded, 7);
  assert.equal(result.failed, 0);
  assert.equal(result.gapsMs.count, 14);
  assert.equal(result.firstContentMs.count, 7);
  assert.ok(
    result.samples.every(
      (s) => s.contentEvents === 3 && s.firstContentMs <= s.totalMs,
    ),
  );
});

test("HTTP failures and stalled responses are reported, not omitted from results", async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === "/fail") res.writeHead(429).end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const failure = await measureRequest({
    url: `${url}/fail`,
    body: {},
    expectedContent: MOCK_CONTENT,
  });
  assert.equal(failure.ok, false);
  assert.equal(failure.status, 429);
  const stalled = await measureRequest({
    url: `${url}/stall`,
    body: {},
    timeoutMs: 30,
    expectedContent: MOCK_CONTENT,
  });
  assert.equal(stalled.ok, false);
  assert.match(stalled.error, /deadline/);
});

test("a 200 response with the wrong body fails the mock contract", async (t) => {
  const server = createMockServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const result = await measureRequest({
    url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    body: { model: "mock" },
    expectedContent: "wrong-marker",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unexpected mock/);
});

test("a failed block stops new load while accounting for in-flight requests", async (t) => {
  const server = http.createServer((_req, res) => res.writeHead(503).end("{}"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const result = await runBlock({
    url: `http://127.0.0.1:${server.address().port}/`,
    body: {},
    expectedContent: MOCK_CONTENT,
    count: 100,
    concurrency: 3,
  });
  assert.equal(result.attempted, 3);
  assert.equal(result.failed, 3);
  assert.equal(result.successfulRequestsPerSecond, 0);
  assert.equal(result.totalMs, null);
});

test("warmup failure stops scheduling and never starts a measured block", async (t) => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(503).end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await assert.rejects(
    runBlock({
      url: `http://127.0.0.1:${server.address().port}/`,
      body: {},
      expectedContent: MOCK_CONTENT,
      count: 100,
      warmup: 30,
      concurrency: 3,
    }),
    /Warmup failed/,
  );
  assert.equal(requests, 3);
});
