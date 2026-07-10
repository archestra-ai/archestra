// Batched TOON encoding of tool results via the native Rust addon
// (@archestra/proxy-transform-rs), off the JS thread. Fail-open: any
// load/call failure resolves to null so adapters skip compression for the
// request and the handler records the explicit `addon_unavailable` skip
// reason instead of fabricating stats.

import type {
  BeforeSource,
  ToonEncodeItem,
  ToonEncodeResult,
} from "@archestra/proxy-transform-rs";
import logger from "@/logging";
import { metrics } from "@/observability";

export type { ToonEncodeItem, ToonEncodeResult };

/**
 * Which string the adapter tokenizes as the pre-compression baseline, so the
 * native pass returns matching `beforeTokens`/`encodedTokens`: `"normalized"`
 * (post-unwrap) for most adapters, `"raw"` (the original serialization) for
 * Gemini. Omit it to skip counting (Anthropic and Bedrock count with their own
 * tokenizer). Adapters pass the string literal, so this stays module-local.
 */
type ToonBeforeSource = "raw" | "normalized";

// The native binding types `beforeSource` as a `const enum` (string values
// "Raw"/"Normalized"). esbuild/tsx cannot inline a const enum across modules,
// so adapters must not reference its members; instead they pass this friendly
// union and the underlying string values are supplied here, at the one call
// site, matched to the enum's own values.
const NATIVE_BEFORE_SOURCE: Record<ToonBeforeSource, BeforeSource> = {
  raw: "Raw" as unknown as BeforeSource,
  normalized: "Normalized" as unknown as BeforeSource,
};

/**
 * Transform a batch of tool results (optional client-wrapper unwrap → JSON
 * parse → TOON encode). Results are positional — same order and length as
 * `items`; `encoded` is null for content that is not parseable JSON.
 *
 * When `beforeSource` is given, the native pass also returns the cl100k token
 * counts (`beforeTokens`/`encodedTokens`) that gate the keep/reject decision,
 * off the event loop. They are populated for every encodable item; a requested
 * count coming back absent means the native tokenizer is unavailable, treated
 * the same as a missing addon (return null, skip compression).
 *
 * Returns null when the native addon is unavailable or misbehaves (callers
 * must then skip compression entirely and surface `addon_unavailable`).
 */
export async function toonEncodeToolResults(
  items: ToonEncodeItem[],
  beforeSource?: ToonBeforeSource,
): Promise<ToonEncodeResult[] | null> {
  try {
    const native = await loadProxyTransformNative();
    const results = await native.toonEncodeToolResults(
      items,
      beforeSource ? NATIVE_BEFORE_SOURCE[beforeSource] : undefined,
    );
    if (results.length !== items.length) {
      throw new Error(
        `native toonEncodeToolResults returned ${results.length} results for ${items.length} items`,
      );
    }
    assertTokenCountInvariant(results, beforeSource !== undefined);
    return results;
  } catch (error) {
    logger.error(
      { err: error, itemCount: items.length },
      "[toon-native] native TOON encode failed — skipping tool result compression for this request",
    );
    metrics.llm.reportToonAddonUnavailable("request");
    return null;
  }
}

/**
 * Eager startup probe: load the addon once so a broken deployment surfaces at
 * boot (error log + metric) instead of silently skipping compression per
 * request. Never throws — the proxy fails open.
 */
export async function initToonNative(): Promise<void> {
  try {
    await loadProxyTransformNative();
    logger.info("[toon-native] native proxy-transform addon loaded");
  } catch (error) {
    logger.error(
      { err: error },
      "[toon-native] failed to load @archestra/proxy-transform-rs at startup — TOON compression will be skipped (addon_unavailable)",
    );
    metrics.llm.reportToonAddonUnavailable("startup");
  }
}

// Guard the token-count contract at the boundary: a requested count that comes
// back absent, or a stray count when none was requested, would silently corrupt
// the keep/reject decision (NaN comparisons, bogus stats). Throwing routes it
// into the fail-open path (return null → addon_unavailable) instead.
function assertTokenCountInvariant(
  results: ToonEncodeResult[],
  counted: boolean,
): void {
  for (const { encoded, beforeTokens, encodedTokens } of results) {
    if (counted && encoded !== null) {
      if (!isCount(beforeTokens) || !isCount(encodedTokens)) {
        throw new Error(
          "native toonEncodeToolResults omitted token counts for an encoded item",
        );
      }
    } else if (beforeTokens !== null || encodedTokens !== null) {
      throw new Error(
        "native toonEncodeToolResults returned token counts that were not requested",
      );
    }
  }
}

function isCount(value: number | null): value is number {
  return value !== null && Number.isInteger(value) && value >= 0;
}

// Lazy, memoized load of the native addon: codegen and paths that never
// compress tool results don't require the built `.node`. Mirrors
// utils/image-conversion.ts and the sandbox/app-runtime native loaders.
type ProxyTransformBindings = typeof import("@archestra/proxy-transform-rs");
let nativeBindings: Promise<ProxyTransformBindings> | null = null;
function loadProxyTransformNative(): Promise<ProxyTransformBindings> {
  nativeBindings ??= import("@archestra/proxy-transform-rs");
  return nativeBindings;
}
