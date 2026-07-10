/**
 * Benchmark backend selection for the TOON kernel harness (T0/T8):
 *   BENCH_BACKEND=ts      (default) TS reference implementation
 *   BENCH_BACKEND=native  the real production helper (utils/toon-native.ts)
 *                         over the Rust addon, so JS→Rust string copies, async
 *                         scheduling, and result conversion are all inside the
 *                         measurement.
 *
 * Both backends share the "batch of { rawContent, unwrap } → results"
 * boundary, corpora, and stats output — the pre-registered threshold compares
 * exactly these two numbers.
 */
import "./bench-env";
import {
  encodeToolResultsReference,
  type ToonKernelItem,
  type ToonKernelResult,
} from "./toon-kernel-reference";

export interface ToonBenchBackend {
  name: "ts" | "native";
  encode: (items: ToonKernelItem[]) => Promise<ToonKernelResult[]>;
}

export async function resolveToonBackend(): Promise<ToonBenchBackend> {
  const requested = process.env.BENCH_BACKEND ?? "ts";
  switch (requested) {
    case "ts":
      return {
        name: "ts",
        encode: async (items) => encodeToolResultsReference(items),
      };
    case "native": {
      // Dynamic import keeps the backend module graph (logging, metrics,
      // config) out of TS-backend runs.
      const { toonEncodeToolResults } = await import("../utils/toon-native");
      return {
        name: "native",
        encode: async (items) => {
          const results = await toonEncodeToolResults(
            items.map(({ rawContent, unwrap }, i) => ({
              id: `bench_${i}`,
              rawContent,
              unwrap,
            })),
          );
          if (results === null) {
            throw new Error(
              "native TOON backend unavailable (addon failed to load)",
            );
          }
          return results;
        },
      };
    }
    default:
      throw new Error(
        `unknown BENCH_BACKEND "${requested}" (expected "ts" or "native")`,
      );
  }
}
