/**
 * Benchmark (c): concurrency guardrail scenario.
 *
 * Runs 8 concurrent async batches of the TOON kernel (mixed 1KB-5MB items,
 * ~8.8MB per batch, ~70MB total) with an event-loop yield between items,
 * and reports p50/p99/max event-loop delay plus peak RSS.
 *
 * Run from platform/backend:
 *   pnpm exec tsx src/routes/proxy/__bench__/bench-concurrency.ts
 */
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { fmt } from "./bench-util";
import { batchBytes, buildBatch, type CorpusSpec } from "./corpus";
import {
  encodeToolResultsReference,
  type ToonKernelItem,
} from "./toon-kernel-reference";

const CONCURRENCY = 8;

const WORKER_PARTS: CorpusSpec[] = [
  { name: "w-5MB", payloadBytes: 5 << 20, count: 1 },
  { name: "w-1MB", payloadBytes: 1 << 20, count: 2 },
  { name: "w-100KB", payloadBytes: 100 << 10, count: 10 },
  { name: "w-10KB", payloadBytes: 10 << 10, count: 20 },
  { name: "w-1KB", payloadBytes: 1 << 10, count: 50 },
];

function buildWorkerBatch(seed: number): ToonKernelItem[] {
  return WORKER_PARTS.flatMap((part, i) => buildBatch(part, seed + i * 31));
}

// Prevents dead-code elimination of the encode results.
let sink = 0;
let peakRss = 0;

function sampleRss(): void {
  const rss = process.memoryUsage().rss;
  if (rss > peakRss) {
    peakRss = rss;
  }
}

async function worker(items: ToonKernelItem[]): Promise<void> {
  for (const item of items) {
    const [result] = encodeToolResultsReference([item]);
    sink += result.encoded === null ? 0 : result.encoded.length;
    sampleRss();
    await yieldEventLoop();
  }
}

async function main(): Promise<void> {
  const batches: ToonKernelItem[][] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    batches.push(buildWorkerBatch(1000 + i));
  }
  const totalMB =
    batches.reduce((sum, b) => sum + batchBytes(b), 0) / (1 << 20);
  const baselineRssMB = process.memoryUsage().rss / (1 << 20);

  const histogram = monitorEventLoopDelay({ resolution: 10 });
  const rssTimer = setInterval(sampleRss, 25);
  histogram.enable();
  const start = performance.now();
  await Promise.all(batches.map((b) => worker(b)));
  const wallMs = performance.now() - start;
  histogram.disable();
  clearInterval(rssTimer);
  sampleRss();

  const toMs = (ns: number) => ns / 1e6;
  console.info(
    "bench-concurrency: 8 concurrent TOON kernel batches (baseline)",
  );
  console.info(
    [
      `total=${fmt(totalMB, 1)}MB`,
      `wall=${fmt(wallMs)}ms`,
      `elDelay p50=${fmt(toMs(histogram.percentile(50)))}ms`,
      `p99=${fmt(toMs(histogram.percentile(99)))}ms`,
      `max=${fmt(toMs(histogram.max))}ms`,
      `rss baseline=${fmt(baselineRssMB, 1)}MB`,
      `peak=${fmt(peakRss / (1 << 20), 1)}MB`,
    ].join("  "),
  );
  console.info(`(sink=${sink})`);
}

main();
