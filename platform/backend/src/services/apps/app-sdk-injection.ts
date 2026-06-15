// The app HTML envelope — anchor selection, inline-script-safe serialization of
// the per-viewer context, and injection of the baseline stylesheet, bootstrap,
// and SDK script — lives in the `app_runtime_core` Rust crate and is reached
// through the `app-runtime-rs` NAPI adapter. This module is the thin TypeScript
// boundary: it owns the serve-time route paths and the context shape, and
// delegates the transform to the native core.

import { getAppAssetBaseOrigin } from "@/config";
import type { AppUiCsp } from "@/types/app";
import { loadAppRuntimeNative } from "./app-runtime-native";
import { APP_PLATFORM_CSP } from "./app-ui-policy";

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

/** Path the backend serves the ext-apps guest SDK bundle on (see server.ts). */
const EXT_APPS_SDK_PATH = "/_sandbox/ext-apps-app.js";

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
  const baseOrigin = getAppAssetBaseOrigin();
  // The SDK reads the ext-apps guest bundle URL from the bootstrap context, so
  // a foreign host that never runs Archestra's sandbox proxy can still load it.
  const fullContext = {
    ...context,
    sdkUrl: `${baseOrigin}${EXT_APPS_SDK_PATH}`,
  };
  return prepareAppEnvelope(
    html,
    JSON.stringify(fullContext),
    baseOrigin,
    buildPlatformCspContent(baseOrigin, APP_PLATFORM_CSP),
  );
}

/**
 * The Content-Security-Policy pinned into every owned app's envelope, so the
 * platform sandbox travels with the resource into a foreign host (which serves
 * no CSP of its own for it). Mirrors the client-side `buildCSP` in
 * `static/mcp-sandbox-proxy.html` (the path that still governs external MCP-UI
 * apps), but with absolute, `baseOrigin`-rooted asset URLs. Owned apps always
 * use {@link APP_PLATFORM_CSP}; the domains are a fixed trusted allowlist, never
 * author input, so they need no per-value sanitization.
 *
 * @public — exercised by app-sdk-injection.test.ts (knip --production ignores tests)
 */
export function buildPlatformCspContent(
  baseOrigin: string,
  csp: AppUiCsp,
): string {
  const resourceDomains = csp.resourceDomains ?? [];
  const connectDomains = csp.connectDomains ?? [];
  const frameDomains = csp.frameDomains ?? [];
  const baseUriDomains = csp.baseUriDomains ?? [];

  const resourceSrc =
    resourceDomains.length > 0
      ? ["data:", "blob:", ...resourceDomains].join(" ")
      : "data: blob:";
  const connectSrc =
    connectDomains.length > 0 ? connectDomains.join(" ") : "'none'";
  const frameSrc = frameDomains.length > 0 ? frameDomains.join(" ") : "'none'";
  const baseUri =
    baseUriDomains.length > 0 ? baseUriDomains.join(" ") : "'none'";

  const extAppsSdk = `${baseOrigin}${EXT_APPS_SDK_PATH}`;
  const archestraSdk = `${baseOrigin}${APP_SDK_PATH}`;
  const baseCss = `${baseOrigin}${APP_BASE_CSS_PATH}`;

  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${extAppsSdk} ${archestraSdk} ${resourceSrc}`,
    `style-src 'unsafe-inline' ${baseCss} ${resourceSrc}`,
    `img-src ${resourceSrc}`,
    `font-src ${resourceSrc}`,
    `media-src ${resourceSrc}`,
    `connect-src ${connectSrc}`,
    "form-action 'none'",
    `frame-src ${frameSrc}`,
    "object-src 'none'",
    `base-uri ${baseUri}`,
  ].join("; ");
}
