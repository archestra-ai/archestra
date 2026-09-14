import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";

export function summarize(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (p) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return {
    count: sorted.length,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: quantile(0.5),
    p95: quantile(0.95),
    p99: quantile(0.99),
    min: sorted[0],
    max: sorted.at(-1),
  };
}

// TCP chunks and SSE events are different boundaries. Decode UTF-8 before
// splitting frames; one read can contain many events or part of one event.
export class CompletionReader {
  constructor({ streaming, onContent = () => {} }) {
    this.streaming = streaming;
    this.onContent = onContent;
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
    this.content = "";
    this.done = false;
  }

  push(bytes) {
    this.buffer += this.decoder.write(bytes);
    if (!this.streaming) return;
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      const frame = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      if (data === "[DONE]") {
        this.done = true;
        continue;
      }
      const event = JSON.parse(data);
      if (event.error) throw new Error("Upstream SSE error");
      const content = event.choices?.[0]?.delta?.content;
      if (typeof content === "string" && content.length) {
        this.content += content;
        this.onContent();
      }
    }
  }

  finish() {
    this.buffer += this.decoder.end();
    if (this.streaming) {
      if (!this.done || this.buffer.trim())
        throw new Error("Incomplete SSE response");
    } else {
      const parsed = JSON.parse(this.buffer);
      this.content = parsed.choices?.[0]?.message?.content;
    }
    return this.content;
  }
}

export async function measureRequest({
  url,
  body,
  agent,
  headers,
  expectedContent,
  timeoutMs = 10000,
}) {
  const target = new URL(url);
  const start = performance.now();
  let firstByteMs;
  const contentTimes = [];
  const gapsMs = [];
  const reader = new CompletionReader({
    streaming: !!body.stream,
    onContent() {
      const time = performance.now() - start;
      if (contentTimes.length) gapsMs.push(time - contentTimes.at(-1));
      contentTimes.push(time);
    },
  });
  const payload = JSON.stringify(body);
  return new Promise((resolve) => {
    let settled = false;
    let status;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({
        ok: !error,
        status: status ?? null,
        error: error?.message ?? null,
        totalMs: performance.now() - start,
        firstByteMs: firstByteMs ?? null,
        firstContentMs: contentTimes[0] ?? null,
        contentEvents: contentTimes.length,
        gapsMs,
      });
    };
    const req = (target.protocol === "https:" ? https : http).request(target, {
      method: "POST",
      agent,
      headers: {
        ...headers,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      },
    });
    // Wall-clock deadline, including connection acquisition and slow streams.
    const deadline = setTimeout(
      () => req.destroy(new Error("Request deadline exceeded")),
      timeoutMs,
    );
    req.on("error", finish);
    req.on("response", (res) => {
      status = res.statusCode;
      res.on("error", finish);
      res.on("aborted", () => finish(new Error("Response aborted")));
      res.on("data", (bytes) => {
        firstByteMs ??= performance.now() - start;
        try {
          reader.push(bytes);
        } catch (error) {
          finish(error);
          res.destroy();
        }
      });
      res.on("end", () => {
        try {
          if (status !== 200) throw new Error(`HTTP ${status}`);
          if (reader.finish() !== expectedContent)
            throw new Error("Unexpected mock response content");
          finish();
        } catch (error) {
          finish(error);
        }
      });
    });
    req.end(payload);
  });
}

export async function runBlock({ count, concurrency, warmup = 0, ...request }) {
  let next = 0;
  let stopped = false;
  const samples = [];
  const agent = new (request.url.startsWith("https:") ? https : http).Agent({
    keepAlive: true,
    maxSockets: concurrency,
    maxFreeSockets: concurrency,
  });
  let started;
  try {
    if (warmup) {
      let warmIndex = 0;
      let warmupError;
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (!warmupError && warmIndex++ < Math.max(warmup, concurrency)) {
            const result = await measureRequest({ ...request, agent });
            if (!result.ok)
              warmupError ??= new Error(`Warmup failed: ${result.error}`);
          }
        }),
      );
      if (warmupError) throw warmupError;
    }
    started = performance.now();
    await Promise.all(
      Array.from({ length: Math.min(count, concurrency) }, async () => {
        while (!stopped && next < count) {
          const index = next++;
          const sample = {
            index,
            ...(await measureRequest({ ...request, agent })),
          };
          samples.push(sample);
          if (!sample.ok) stopped = true;
        }
      }),
    );
  } finally {
    agent.destroy();
  }
  const elapsedMs = performance.now() - started;
  const success = samples.filter((sample) => sample.ok);
  return {
    attempted: samples.length,
    succeeded: success.length,
    failed: samples.length - success.length,
    elapsedMs,
    successfulRequestsPerSecond: success.length / (elapsedMs / 1000),
    totalMs: summarize(success.map((sample) => sample.totalMs)),
    firstByteMs: summarize(
      success.map((sample) => sample.firstByteMs).filter((v) => v !== null),
    ),
    firstContentMs: summarize(
      success.map((sample) => sample.firstContentMs).filter((v) => v !== null),
    ),
    // Event-weighted distribution of client-observed content-event gaps.
    gapsMs: summarize(success.flatMap((sample) => sample.gapsMs)),
    samples: samples.sort((a, b) => a.index - b.index),
  };
}
