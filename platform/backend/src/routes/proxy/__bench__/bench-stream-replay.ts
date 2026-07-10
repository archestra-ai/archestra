/**
 * Benchmark (b): streaming tool-call replay quadratic path.
 *
 * Feeds OpenAIStreamAdapter a synthetic stream of tool-call argument
 * fragments and, after every fragment chunk, calls getRawToolCallEvents()
 * plus the handler's written-index dedup loop — mimicking the per-chunk
 * non-blocking-policy path at llm-proxy-handler.ts:1214-1221. The
 * re-serialization of the full event history on every call is the O(k^2)
 * term this baseline pins down.
 *
 * Run from platform/backend:
 *   pnpm exec tsx src/routes/proxy/__bench__/bench-stream-replay.ts
 */
import "./bench-env";
import { performance } from "node:perf_hooks";
import type { OpenAi } from "@/types";
import { OpenAIStreamAdapter } from "../adapters/openai";
import { fmt, summarize } from "./bench-util";

type Chunk = OpenAi.Types.ChatCompletionChunk;

const FRAGMENT_COUNTS = [100, 500, 1000, 2000];
const REPEATS = 5;
const FRAGMENT = '{"query":"synthetic fragment payload #';

function makeChunk(fragmentIndex: number): Chunk {
  const first = fragmentIndex === 0;
  return {
    id: "chatcmpl-bench",
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: "gpt-bench",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            first
              ? {
                  index: 0,
                  id: "call_bench_0",
                  type: "function",
                  function: { name: "search_documents", arguments: "" },
                }
              : {
                  index: 0,
                  function: { arguments: `${FRAGMENT}${fragmentIndex}"}` },
                },
          ],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  };
}

// Prevents dead-code elimination of the replayed SSE strings.
let sink = 0;

function runScenario(fragmentCount: number): number {
  const adapter = new OpenAIStreamAdapter("openai");
  const streamedEventIndices = new Set<number>();
  const chunks: Chunk[] = [];
  for (let i = 0; i < fragmentCount; i++) {
    chunks.push(makeChunk(i));
  }

  const start = performance.now();
  for (const chunk of chunks) {
    const result = adapter.processChunk(chunk);
    if (result.isToolCallChunk) {
      // Handler's per-chunk replay + dedup (llm-proxy-handler.ts:1214-1221).
      const allEvents = adapter.getRawToolCallEvents();
      for (let i = 0; i < allEvents.length; i++) {
        if (!streamedEventIndices.has(i)) {
          sink += allEvents[i].length;
          streamedEventIndices.add(i);
        }
      }
    }
  }
  return performance.now() - start;
}

console.info(
  "bench-stream-replay: per-chunk getRawToolCallEvents replay (baseline)",
);
const perCount = new Map<number, number>();
for (const fragmentCount of FRAGMENT_COUNTS) {
  runScenario(fragmentCount); // warmup
  const samples: number[] = [];
  for (let r = 0; r < REPEATS; r++) {
    samples.push(runScenario(fragmentCount));
  }
  const s = summarize(samples);
  perCount.set(fragmentCount, s.meanMs);
  console.info(
    [
      `fragments=${String(fragmentCount).padStart(5)}`,
      `mean=${fmt(s.meanMs).padStart(9)}ms`,
      `stdev=${fmt(s.stdevMs).padStart(7)}ms`,
      `min=${fmt(s.minMs).padStart(9)}ms`,
      `perChunk=${fmt(s.meanMs / fragmentCount, 4).padStart(8)}ms`,
    ].join("  "),
  );
}

const base = perCount.get(FRAGMENT_COUNTS[0]);
if (base !== undefined && base > 0) {
  for (const fragmentCount of FRAGMENT_COUNTS.slice(1)) {
    const ratio = (perCount.get(fragmentCount) ?? 0) / base;
    const kRatio = fragmentCount / FRAGMENT_COUNTS[0];
    console.info(
      `scaling ${FRAGMENT_COUNTS[0]} -> ${fragmentCount}: time x${fmt(ratio, 1)} ` +
        `(linear would be x${fmt(kRatio, 0)}, quadratic x${fmt(kRatio ** 2, 0)})`,
    );
  }
}
console.info(`(sink=${sink})`);
