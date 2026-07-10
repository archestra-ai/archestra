import { encode as toonEncode } from "@toon-format/toon";
import { unwrapToolContent } from "../utils/unwrap-tool-content";

export interface ToonKernelItem {
  rawContent: string;
  unwrap: boolean;
}

export interface ToonKernelResult {
  normalized: string;
  encoded: string | null;
}

/**
 * TS reference backend for the planned native kernel boundary:
 * batch of { rawContent, unwrap } -> { normalized, encoded }.
 *
 * Mirrors the per-item pipeline of convertToolResultsToToon
 * (../adapters/openai.ts:1261+): unwrapToolContent -> JSON.parse ->
 * toonEncode, yielding `encoded: null` when the content is not parseable
 * JSON (the adapter then keeps the original content). The double parse
 * (inside unwrapToolContent and again here) is deliberate — it is what the
 * production path pays today. Output equivalence with the real adapter path
 * is checked by validate-reference.ts.
 */
export function encodeToolResultsReference(
  items: ToonKernelItem[],
): ToonKernelResult[] {
  return items.map(({ rawContent, unwrap }) => {
    const normalized = unwrap ? unwrapToolContent(rawContent) : rawContent;
    try {
      const parsed = JSON.parse(normalized);
      return { normalized, encoded: toonEncode(parsed) };
    } catch {
      return { normalized, encoded: null };
    }
  });
}
