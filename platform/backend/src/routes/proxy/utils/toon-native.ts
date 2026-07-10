// Batched TOON encoding of tool results via the native Rust addon
// (@archestra/proxy-transform-rs), off the JS thread. Fail-open: any
// load/call failure resolves to null so adapters skip compression for the
// request and the handler records the explicit `addon_unavailable` skip
// reason instead of fabricating stats.

import type {
  ToonEncodeItem,
  ToonEncodeResult,
} from "@archestra/proxy-transform-rs";
import logger from "@/logging";
import { metrics } from "@/observability";

export type { ToonEncodeItem, ToonEncodeResult };

/**
 * Transform a batch of tool results (optional client-wrapper unwrap → JSON
 * parse → TOON encode). Results are positional — same order and length as
 * `items`; `encoded` is null for content that is not parseable JSON.
 *
 * Returns null when the native addon is unavailable or misbehaves (callers
 * must then skip compression entirely and surface `addon_unavailable`).
 */
export async function toonEncodeToolResults(
  items: ToonEncodeItem[],
): Promise<ToonEncodeResult[] | null> {
  try {
    const native = await loadProxyTransformNative();
    const results = await native.toonEncodeToolResults(items);
    if (results.length !== items.length) {
      throw new Error(
        `native toonEncodeToolResults returned ${results.length} results for ${items.length} items`,
      );
    }
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

// Lazy, memoized load of the native addon: codegen and paths that never
// compress tool results don't require the built `.node`. Mirrors
// utils/image-conversion.ts and the sandbox/app-runtime native loaders.
type ProxyTransformBindings = typeof import("@archestra/proxy-transform-rs");
let nativeBindings: Promise<ProxyTransformBindings> | null = null;
function loadProxyTransformNative(): Promise<ProxyTransformBindings> {
  nativeBindings ??= import("@archestra/proxy-transform-rs");
  return nativeBindings;
}
