/**
 * Profiling bench: what does the JS token counting on the TOON keep/reject
 * decision path actually cost, and would moving it into the off-thread native
 * kernel be justified?
 *
 * The current path per request is: 1 native encode (off-thread, libuv) then
 * `2 x N` synchronous `getTokenizer(provider).countTokens([...])` calls on the
 * event loop (before = normalized, after = encoded), each a WASM cl100k encode
 * unless the per-message memo (base.ts) hits.
 *
 * This measures three regimes that decide the question:
 *   1. sequential per-candidate cost, COLD (unique content, cache miss — Rust's
 *      win case) vs WARM (repeated history, cache hit — Rust's regression risk);
 *   2. event-loop delay under 8-way concurrency with counting ON vs OFF (what
 *      off-loading the synchronous counting to libuv would recover);
 *   3. transient JS heap allocation from the token-id arrays.
 *
 * Run from platform/backend (add --expose-gc for the retained/transient split):
 *   pnpm exec tsx src/routes/proxy/__bench__/bench-token-count.ts
 *   node --expose-gc --import tsx src/routes/proxy/__bench__/bench-token-count.ts
 */
import "./bench-env";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { getTokenizer } from "@/tokenizers";
import { toonEncodeToolResults } from "../utils/toon-native";
import { fmt, summarize } from "./bench-util";
import {
  batchBytes,
  buildBatch,
  CORPUS_SPECS,
  type CorpusSpec,
} from "./corpus";
import { encodeBatchNative, type ToonKernelItem } from "./toon-backend";

// All five tiktoken-family TOON adapters count with cl100k under role "user"
// (see base.ts getEncodableText). openai stands in for the whole family.
const PROVIDER = "openai" as const;
const TIME_BUDGET_MS = 3_000;
const MIN_ITERATIONS = 5;
const MAX_ITERATIONS = 400;
const CONCURRENCY = 8;

let sink = 0;

// A candidate as the decision loop sees it: the two strings it tokenizes.
interface Countable {
  before: string;
  after: string;
}

/** Run the batch through the real native encoder, keep only encodable items. */
async function encodeCountables(items: ToonKernelItem[]): Promise<Countable[]> {
  const results = await encodeBatchNative(items);
  const countables: Countable[] = [];
  results.forEach((r, i) => {
    // Skip non-JSON / budget-rejected items — the adapters skip counting them.
    if (r.encoded !== null) {
      countables.push({ before: items[i].rawContent, after: r.encoded });
    }
  });
  return countables;
}

/** The exact per-candidate work the adapters do: two role-"user" counts. */
function countOnce(items: Countable[], nonce: string): void {
  const tokenizer = getTokenizer(PROVIDER);
  for (const { before, after } of items) {
    // A non-empty nonce forces a fresh cache key (cold path); "" replays the
    // same strings so the second+ pass hits the memo (warm path).
    const b = tokenizer.countTokens([
      { role: "user", content: nonce + before },
    ]);
    const a = tokenizer.countTokens([{ role: "user", content: nonce + after }]);
    sink += b + a;
  }
}

function timedIterations(run: (iter: number) => void): {
  meanMs: number;
  minMs: number;
  iterations: number;
} {
  const samples: number[] = [];
  const budgetStart = performance.now();
  while (
    samples.length < MAX_ITERATIONS &&
    (samples.length < MIN_ITERATIONS ||
      performance.now() - budgetStart < TIME_BUDGET_MS)
  ) {
    const start = performance.now();
    run(samples.length);
    samples.push(performance.now() - start);
  }
  const s = summarize(samples);
  return { meanMs: s.meanMs, minMs: s.minMs, iterations: s.iterations };
}

async function section1Sequential(): Promise<void> {
  console.info(
    "\n[1] Sequential JS token counting cost per candidate (cl100k, 2 counts each)",
  );
  console.info(
    "    warm = repeated content (memo hit); cold = unique content (memo miss, real WASM encode)",
  );
  for (const spec of CORPUS_SPECS) {
    if (spec.payloadBytes > 1 << 20) {
      continue; // 1KB..1MB spans realistic tool-result sizes; skip 5MB here.
    }
    const items = await encodeCountables(buildBatch(spec, 42));
    if (items.length === 0) {
      continue;
    }
    // Warm: same strings every pass — after the first, all memo hits.
    const warm = timedIterations(() => countOnce(items, ""));
    // Cold: a unique per-iteration prefix defeats the memo every pass.
    const cold = timedIterations((iter) => countOnce(items, `c${iter}_`));

    const perCandWarmUs = (warm.meanMs / items.length) * 1000;
    const perCandColdUs = (cold.meanMs / items.length) * 1000;
    console.info(
      [
        spec.name.padEnd(6),
        `cand=${String(items.length).padStart(4)}`,
        `cold=${fmt(perCandColdUs, 1).padStart(8)}us/cand`,
        `warm=${fmt(perCandWarmUs, 2).padStart(8)}us/cand`,
        `cold/warm=${fmt(perCandColdUs / Math.max(perCandWarmUs, 1e-6), 0).padStart(5)}x`,
        `coldBatch=${fmt(cold.minMs).padStart(8)}ms`,
      ].join("  "),
    );
  }
}

async function section2EventLoop(): Promise<void> {
  console.info("\n[2] Event-loop delay under 8 concurrent batches:");
  console.info(
    "    none = encode only; js = encode + synchronous WASM count (old); native = encode + fused count (new, off-thread)",
  );
  const batches: ToonKernelItem[][] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    // Mixed 1KB..100KB, ~realistic tool-result batches.
    batches.push(
      [
        { name: "100KB", payloadBytes: 100 << 10, count: 8 },
        { name: "10KB", payloadBytes: 10 << 10, count: 24 },
        { name: "1KB", payloadBytes: 1 << 10, count: 48 },
      ].flatMap((p: CorpusSpec, j) => buildBatch(p, 2000 + i * 17 + j * 5)),
    );
  }
  const totalMB = batches.reduce((s, b) => s + batchBytes(b), 0) / (1 << 20);

  for (const mode of ["none", "js", "native"] as const) {
    let peakRss = 0;
    const sampleRss = () => {
      const rss = process.memoryUsage().rss;
      if (rss > peakRss) {
        peakRss = rss;
      }
    };
    const tokenizer = getTokenizer(PROVIDER);
    const worker = async (items: ToonKernelItem[]) => {
      for (const item of items) {
        if (mode === "native") {
          // New path: encode + count in one off-thread native call.
          const results = await toonEncodeToolResults(
            [{ id: "b", rawContent: item.rawContent, unwrap: item.unwrap }],
            "normalized",
          );
          const r = results?.[0];
          if (r) {
            sink += (r.beforeTokens ?? 0) + (r.encodedTokens ?? 0);
          }
        } else {
          const [r] = await encodeBatchNative([item]);
          if (mode === "js" && r.encoded !== null) {
            // Old path: synchronous WASM counting on the event loop, unique per
            // item so the memo never hides the cost (worst case).
            sink += tokenizer.countTokens([
              {
                role: "user",
                content: `${item.rawContent.length}:${item.rawContent}`,
              },
            ]);
            sink += tokenizer.countTokens([
              { role: "user", content: r.encoded },
            ]);
          }
        }
        sampleRss();
        await yieldEventLoop();
      }
    };
    const histogram = monitorEventLoopDelay({ resolution: 10 });
    const rssTimer = setInterval(sampleRss, 25);
    histogram.enable();
    const start = performance.now();
    await Promise.all(batches.map((b) => worker(b)));
    const wallMs = performance.now() - start;
    histogram.disable();
    clearInterval(rssTimer);
    const toMs = (ns: number) => ns / 1e6;
    console.info(
      [
        `mode=${mode.padEnd(6)}`,
        `total=${fmt(totalMB, 1)}MB`,
        `wall=${fmt(wallMs).padStart(9)}ms`,
        `elDelay p50=${fmt(toMs(histogram.percentile(50))).padStart(7)}ms`,
        `p99=${fmt(toMs(histogram.percentile(99))).padStart(8)}ms`,
        `max=${fmt(toMs(histogram.max)).padStart(9)}ms`,
        `peakRss=${fmt(peakRss / (1 << 20), 1)}MB`,
      ].join("  "),
    );
  }
}

async function section3Memory(): Promise<void> {
  console.info(
    "\n[3] Transient JS heap from token-id arrays (cold counting of a 100KB x 64 batch)",
  );
  const items = await encodeCountables(
    buildBatch({ name: "100KB", payloadBytes: 100 << 10, count: 64 }, 7),
  );
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc) {
    gc();
  }
  const before = process.memoryUsage();
  const PASSES = 50;
  for (let p = 0; p < PASSES; p++) {
    countOnce(items, `m${p}_`); // cold every pass
  }
  const afterNoGc = process.memoryUsage();
  if (gc) {
    gc();
  }
  const afterGc = process.memoryUsage();
  const mb = (n: number) => fmt(n / (1 << 20), 1);
  console.info(
    `    heapUsed  before=${mb(before.heapUsed)}MB  afterLoop=${mb(afterNoGc.heapUsed)}MB  afterGC=${mb(afterGc.heapUsed)}MB`,
  );
  console.info(
    `    external  before=${mb(before.external)}MB  afterLoop=${mb(afterNoGc.external)}MB  afterGC=${mb(afterGc.external)}MB`,
  );
  console.info(
    gc
      ? "    (afterGC ~= before means the counting churn is fully transient, not retained)"
      : "    (re-run with --expose-gc to separate transient churn from retained heap)",
  );
}

async function main(): Promise<void> {
  console.info(
    "bench-token-count: current JS-side cl100k counting on the TOON decision path",
  );
  await section1Sequential();
  await section2EventLoop();
  await section3Memory();
  console.info(`\n(sink=${sink})`);
}

main();
