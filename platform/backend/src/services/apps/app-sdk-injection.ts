// The app HTML envelope — anchor selection, inline-script-safe serialization of
// the per-viewer context, and injection of the baseline stylesheet, bootstrap,
// and SDK script — lives in the `app_runtime_core` Rust crate and is reached
// through the `app-runtime-rs` NAPI adapter. This module is the thin TypeScript
// boundary: it owns the serve-time route paths and the context shape, and
// delegates the transform to the native core.

import { loadAppRuntimeNative } from "./app-runtime-native";

/**
 * Path the backend serves the Apps SDK on (see server.ts). Must match
 * `app_runtime_core::contract::APP_SDK_PATH` — the injected `<script src>` and
 * the served route are the same URL, and the core's envelope tests pin it.
 */
export const APP_SDK_PATH = "/_sandbox/archestra-app-sdk.js";

/**
 * Path the backend serves the platform baseline stylesheet on (see server.ts).
 * Must match `app_runtime_core::contract::APP_BASE_CSS_PATH`.
 */
export const APP_BASE_CSS_PATH = "/_sandbox/archestra-app-base.css";

/** One assigned-tool descriptor embedded for `archestra.tools.list()`. */
export interface AppSdkTool {
  name: string;
  description: string | null;
  inputSchema: unknown;
}

/**
 * Per-viewer values the SDK reads from `window.__ARCHESTRA_APP_CONTEXT__`.
 *
 * @public — consumed by the injection tests, which knip --production ignores
 */
export interface AppSdkContext {
  user: { id: string; name: string } | null;
  tools: AppSdkTool[];
  appId: string;
  version: number;
  // Only the app's author self-captures a render screenshot — they are the one
  // who reads it back via get_app_diagnostics. Other viewers skip the capture
  // (no wasted rasterize, no DOM snapshot of their session).
  captureScreenshot: boolean;
}

/**
 * Inject the Archestra Apps SDK into an owned app's HTML at serve time, so apps
 * author pure UI and never carry protocol glue. The bootstrap carries the
 * per-viewer context (identity, assigned-tool descriptors) the static SDK file
 * reads at parse time. Neither the injected scripts nor the stylesheet are
 * stored in app_versions — they ship fresh on every resources/read.
 */
export async function injectAppSdk(
  html: string,
  context: AppSdkContext,
): Promise<string> {
  const { prepareAppEnvelope } = await loadAppRuntimeNative();
  return prepareAppEnvelope(html, JSON.stringify(context));
}
