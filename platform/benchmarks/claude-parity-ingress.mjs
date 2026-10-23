import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { requestCompletion, verifyCapture } from "./live-ab.mjs";
import { buildBody } from "./live-ab-scenarios.mjs";

export function composeClaudeFixture(
  native,
  { scenario, session, gatewayTools, prefixWords = 6000 },
) {
  assert.ok(
    typeof native.model === "string" && native.model.startsWith("claude-"),
  );
  assert.ok(
    Array.isArray(native.system) &&
      native.system.every(
        (item) => item.type === "text" && typeof item.text === "string",
      ),
  );
  assert.ok(
    native.system.some((item) => /Claude Code/.test(item.text)),
    "Expected genuine native client system context.",
  );
  const fixture = buildBody({
    provider: "anthropic",
    scenario,
    model: native.model,
    session,
    prefixWords,
  });
  fixture.tools.push(
    ...gatewayTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    })),
  );
  // Native auth, billing metadata, model parameters and immutable client context
  // remain native. Workload declarations/transcripts are controlled before the proxy.
  const body = {
    ...native,
    tools: fixture.tools,
    messages: fixture.messages,
    system: [...native.system, ...fixture.system],
    stream: true,
  };
  const markers = JSON.stringify(body).match(/"cache_control":/g)?.length ?? 0;
  assert.ok(markers <= 4, "Too many native/fixture cache breakpoints.");
  return {
    body,
    nativeSystemHash: createHash("sha256")
      .update(JSON.stringify(native.system))
      .digest("hex"),
    transport: "genuine-claude-code-controlled-ingress",
    callerStreaming: true,
  };
}

export async function createClaudeIngress({
  proxyBase,
  captureBase,
  agent,
  gatewayTools,
  prefixWords = 6000,
  timeoutMs = 90000,
}) {
  for (const value of [proxyBase, captureBase]) {
    const url = new URL(value);
    assert.ok(
      url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
    );
    assert.ok(!url.username && !url.password && !url.search && !url.hash);
  }
  assert.ok(/^[a-zA-Z0-9-]+$/.test(agent));
  const jobs = new Map();
  const server = createServer(async (req, res) => {
    const session = req.headers["x-appa-session-id"];
    const job = jobs.get(session);
    const path = new URL(req.url, "http://127.0.0.1");
    if (
      !job ||
      job.started ||
      req.method !== "POST" ||
      path.pathname !== `/v1/anthropic/${agent}/v1/messages` ||
      (path.search && path.search !== "?beta=true")
    ) {
      req.resume();
      res.writeHead(409, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            type: "benchmark_request_refused",
            message:
              "Only one controlled Messages call is admitted per invocation.",
          },
        }),
      );
      if (job) job.additionalCalls++;
      return;
    }
    job.started = true;
    try {
      const parts = [];
      let size = 0;
      for await (const part of req) {
        size += part.length;
        assert.ok(size <= 4 * 1024 * 1024);
        parts.push(part);
      }
      const native = JSON.parse(Buffer.concat(parts).toString("utf8"));
      const composed = composeClaudeFixture(native, {
        scenario: job.scenario,
        session,
        gatewayTools,
        prefixWords,
      });
      const headers = Object.fromEntries(
        Object.entries(req.headers).filter(
          ([name]) =>
            ![
              "host",
              "connection",
              "content-length",
              "transfer-encoding",
              "accept-encoding",
            ].includes(name),
        ),
      );
      let forwarding;
      const result = await requestCompletion({
        provider: "anthropic",
        url: `${proxyBase}/v1/anthropic/${agent}/v1/messages${path.search}`,
        body: composed.body,
        headers,
        timeoutMs,
        fetchImpl: async (...args) => {
          const response = await fetch(...args);
          const responseHeaders = Object.fromEntries(
            [...response.headers].filter(
              ([name]) =>
                ![
                  "content-length",
                  "content-encoding",
                  "transfer-encoding",
                  "connection",
                ].includes(name),
            ),
          );
          res.writeHead(response.status, responseHeaders);
          if (!response.body) {
            res.end();
            return response;
          }
          const [client, measurement] = response.body.tee();
          forwarding = (async () => {
            for await (const part of client) {
              if (!res.write(part)) await once(res, "drain");
            }
            res.end();
          })();
          return new Response(measurement, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        },
      });
      await forwarding;
      const evidenceResponse = await fetch(
        `${captureBase}/evidence?sessionId=${encodeURIComponent(session)}`,
        { signal: AbortSignal.timeout(10000) },
      );
      assert.ok(evidenceResponse.ok);
      const captured = await evidenceResponse.json();
      const records = (captured.records ?? []).filter(
        (record) => record.body && record.status === result.status,
      );
      const record = records.at(-1);
      const evidence = record
        ? {
            ...verifyCapture(composed.body, record.body, job.arm),
            mode: captured.mode,
            idx: record.idx,
            requestHash: record.requestHash,
            leadingPrefixDigest: record.leadingPrefixDigest,
            arrivedUnixMs: record.arrivedUnixMs,
            timingsMs: record.timingsMs,
            capturedCalls: records.length,
          }
        : { mode: captured.mode, missing: true };
      job.resolve({
        ...result,
        evidence,
        nativeSystemHash: composed.nativeSystemHash,
        model: composed.body.model,
        originalNativeToolCount: native.tools?.length ?? 0,
        controlledToolCount: composed.body.tools.length,
        transportLane: composed.transport,
        nativeMetadataVaries: true,
      });
    } catch {
      if (!res.headersSent)
        res.writeHead(502, { "content-type": "application/json" });
      if (!res.writableEnded)
        res.end(
          JSON.stringify({
            error: {
              type: "benchmark_transport_error",
              message: "Controlled native transport did not complete.",
            },
          }),
        );
      job.resolve({
        ok: false,
        error: "native_ingress_failed",
        usage: null,
        evidence: { missing: true },
      });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    register({ session, scenario, arm }) {
      assert.ok(!jobs.has(session));
      let resolve;
      const done = new Promise((r) => {
        resolve = r;
      });
      const job = {
        session,
        scenario,
        arm,
        started: false,
        additionalCalls: 0,
        resolve,
        done,
      };
      jobs.set(session, job);
      return {
        done,
        get additionalCalls() {
          return job.additionalCalls;
        },
        dispose() {
          jobs.delete(session);
        },
      };
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
