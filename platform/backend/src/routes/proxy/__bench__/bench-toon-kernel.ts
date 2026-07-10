/**
 * Benchmark (a): TOON kernel (unwrap -> JSON.parse -> toonEncode) via the TS
 * reference backend, over deterministic synthetic corpora.
 *
 * Run from platform/backend:
 *   pnpm exec tsx src/routes/proxy/__bench__/bench-toon-kernel.ts
 */
import { performance } from "node:perf_hooks";
import { fmt, summarize } from "./bench-util";
import {
  batchBytes,
  buildBatch,
  buildJumboBatch,
  CORPUS_SPECS,
} from "./corpus";
import {
  encodeToolResultsReference,
  type ToonKernelItem,
} from "./toon-kernel-reference";

const TIME_BUDGET_MS = 4_000;
const MIN_ITERATIONS = 5;
const MAX_ITERATIONS = 200;

// Prevents dead-code elimination of the encode results.
let sink = 0;

function runBatch(items: ToonKernelItem[]): number {
  const start = performance.now();
  const results = encodeToolResultsReference(items);
  const elapsed = performance.now() - start;
  for (const r of results) {
    sink += r.encoded === null ? r.normalized.length : r.encoded.length;
  }
  return elapsed;
}

function benchCorpus(name: string, items: ToonKernelItem[]): void {
  const totalMB = batchBytes(items) / (1 << 20);
  runBatch(items); // warmup
  const samples: number[] = [];
  const budgetStart = performance.now();
  while (
    samples.length < MAX_ITERATIONS &&
    (samples.length < MIN_ITERATIONS ||
      performance.now() - budgetStart < TIME_BUDGET_MS)
  ) {
    samples.push(runBatch(items));
  }
  const s = summarize(samples);
  const mbPerSec = totalMB / (s.meanMs / 1000);
  console.info(
    [
      name.padEnd(6),
      `items=${String(items.length).padStart(4)}`,
      `total=${fmt(totalMB, 1).padStart(6)}MB`,
      `iters=${String(s.iterations).padStart(3)}`,
      `mean=${fmt(s.meanMs).padStart(9)}ms/batch`,
      `stdev=${fmt(s.stdevMs).padStart(7)}ms`,
      `min=${fmt(s.minMs).padStart(9)}ms`,
      `throughput=${fmt(mbPerSec, 1).padStart(7)}MB/s`,
      `perItem=${fmt(s.meanMs / items.length, 3).padStart(9)}ms`,
    ].join("  "),
  );
}

console.info("bench-toon-kernel: TS reference backend (baseline)");
for (const spec of CORPUS_SPECS) {
  benchCorpus(spec.name, buildBatch(spec, 42));
}
benchCorpus("70MB", buildJumboBatch(4242));
console.info(`(sink=${sink})`);
