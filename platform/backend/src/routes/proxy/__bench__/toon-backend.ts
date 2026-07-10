/**
 * TOON kernel backend for the benchmark harness (T0/T8): the real production
 * helper (utils/toon-native.ts) over the Rust addon, so JS→Rust string
 * copies, async scheduling, and result conversion are all inside the
 * measurement. Boundary: batch of { rawContent, unwrap } → results.
 *
 * The TS reference backend this was originally compared against (npm
 * @toon-format/toon) was removed once all adapters cut over to the native
 * kernel — baseline numbers are recorded in the PR; git history keeps the
 * code.
 */
import "./bench-env";
import { toonEncodeToolResults } from "../utils/toon-native";

export interface ToonKernelItem {
  rawContent: string;
  unwrap: boolean;
}

export interface ToonKernelResult {
  normalized: string;
  encoded: string | null;
}

export async function encodeBatchNative(
  items: ToonKernelItem[],
): Promise<ToonKernelResult[]> {
  const results = await toonEncodeToolResults(
    items.map(({ rawContent, unwrap }, i) => ({
      id: `bench_${i}`,
      rawContent,
      unwrap,
    })),
  );
  if (results === null) {
    throw new Error("native TOON backend unavailable (addon failed to load)");
  }
  return results;
}
