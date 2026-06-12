import * as cheerio from "cheerio";
import type { VersionPayload } from "@/models/app-version";
import { ApiError } from "@/types";
import {
  APP_HTML_MAX_BYTES,
  type AppUiCsp,
  type AppUiPermissions,
  AppUiPermissionsSchema,
} from "@/types/app";

/**
 * Save-time security policy for an app's UI envelope (iframe permissions) and
 * the platform CSP every owned app is served with.
 *
 * Owned apps are MCP wrappers on a security-first platform: their CSP is not
 * author-controlled. The platform pins one CSP at serve time — assigned MCP
 * tools (plus archestra.storage) are the only data egress, and static assets
 * may load only from the hardcoded CDN allowlist below. External MCP-UI apps
 * (third-party servers) keep declaring their own `_meta.ui.csp` per the spec;
 * that path is untouched.
 */

/**
 * The CSP envelope served for every owned app, regardless of what any stored
 * version says. `resourceDomains` feeds script/style/img/font/media in the
 * sandbox CSP builders — that is the deliberate allowance for client-side
 * libraries and fonts. No `connectDomains` ⇒ connect-src 'none' (fetch/XHR/WS
 * to anything external fails); no frame/baseUri domains ⇒ 'none'. Bare
 * hostnames only: both the save-path grammar and the serve-time
 * `sanitizeCspDomains` filter accept exactly this form. A future feature may
 * make this list org-configurable.
 */
export const APP_PLATFORM_CSP: AppUiCsp = {
  resourceDomains: [
    "cdn.jsdelivr.net",
    "unpkg.com",
    "cdnjs.cloudflare.com",
    "fonts.googleapis.com",
    "fonts.gstatic.com",
  ],
};

// The only iframe permissions an app may request. Mirrors AppUiPermissionsSchema
// (whose .strict() already rejects unknown keys at parse time); kept here as the
// explicit save-time allowlist with a clear per-key error.
const ALLOWED_PERMISSION_KEYS = [
  "camera",
  "microphone",
  "geolocation",
  "clipboardWrite",
] as const satisfies readonly (keyof AppUiPermissions)[];

/**
 * Validate an app's permissions and assemble the version payload to persist.
 * Throws `ApiError(400)` on an unknown permission key or html that bootstraps
 * the MCP App SDK itself (the platform injects `window.archestra` — see
 * app-sdk-injection.ts). Soft structural issues come back as `warnings` (the
 * save succeeds); they ride the create/update responses so authors — human or
 * model — see them. Versions carry no CSP: the serve path always pins
 * {@link APP_PLATFORM_CSP}.
 */
export function buildValidatedVersionPayload(params: {
  html: string;
  uiPermissions?: AppUiPermissions | null;
}): { payload: VersionPayload; warnings: string[] } {
  // Hard byte cap, enforced here so every save path is covered: create/update
  // also bound it at the input-schema level, but edit_app assembles the html
  // from str_replace edits that never touch that field.
  const byteSize = Buffer.byteLength(params.html, "utf8");
  if (byteSize > APP_HTML_MAX_BYTES) {
    throw new ApiError(
      400,
      `app html exceeds the ${APP_HTML_MAX_BYTES}-byte limit (${byteSize} bytes).`,
    );
  }
  const warnings = validateAppHtml(params.html);
  return {
    payload: {
      html: params.html,
      uiPermissions: validateAppUiPermissions(params.uiPermissions ?? null),
    },
    warnings,
  };
}

// Markers of the SDK self-bootstrap the injected Apps SDK replaces. An app
// that wires the SDK itself would race the platform's connection handshake, so
// this is a hard reject — but only inside <script> elements: prose that merely
// mentions a marker (docs, comments rendered as text) must save fine.
const SDK_BOOTSTRAP_MARKERS = [
  "__ARCHESTRA_APP_SDK_URL__",
  "__ARCHESTRA_APP_CONTEXT__",
  "PostMessageTransport",
] as const;

// Platform-served scripts an app must not load itself: the backend injects the
// Apps SDK (with its per-viewer bootstrap) at serve time; a second, authored
// load would run with no bootstrap and race the injected one.
const PLATFORM_SCRIPT_SRC_MARKERS = [
  "archestra-app-sdk",
  "ext-apps-app",
] as const;

// The platform baseline stylesheet is injected at serve time (a <link> in
// <head>); stored HTML must not load it itself, mirroring the SDK rejection.
const PLATFORM_BASE_CSS_MARKER = "archestra-app-base";

function validateAppHtml(html: string): string[] {
  const $ = cheerio.load(html);
  const scriptText = $("script")
    .map((_, el) => $(el).text())
    .get()
    .join("\n");
  for (const marker of SDK_BOOTSTRAP_MARKERS) {
    if (scriptText.includes(marker)) {
      throw new ApiError(
        400,
        `app html must not bootstrap the MCP App SDK itself (found "${marker}" in a <script>). The platform injects window.archestra (storage, tools, user identity, host features) at render time — remove the SDK import and transport wiring and use window.archestra directly.`,
      );
    }
  }
  const scriptSrcs = $("script[src]")
    .map((_, el) => $(el).attr("src") ?? "")
    .get();
  for (const src of scriptSrcs) {
    if (PLATFORM_SCRIPT_SRC_MARKERS.some((marker) => src.includes(marker))) {
      throw new ApiError(
        400,
        `app html must not load the platform SDK itself (found <script src="${src}">). The platform injects window.archestra at render time — remove the script tag and use window.archestra directly.`,
      );
    }
  }
  const linkHrefs = $("link[href]")
    .map((_, el) => $(el).attr("href") ?? "")
    .get();
  for (const href of linkHrefs) {
    // Strip whitespace the browser would ignore when resolving the URL, so a
    // tab/newline spliced into the marker can't slip the self-link past.
    if (href.replace(/\s/g, "").includes(PLATFORM_BASE_CSS_MARKER)) {
      throw new ApiError(
        400,
        `app html must not load the platform stylesheet itself (found <link href="${href}">). The platform injects archestra-app-base.css at render time — remove the link; its theme variables, element defaults, and .arch-* components are already available.`,
      );
    }
  }

  const warnings: string[] = [];
  // cheerio normalizes fragments into a full document, so anchor checks run on
  // the raw input. Without <head>/<html> the bridge injection falls back to
  // prepending — workable, but the document is likely malformed.
  if (!/<head[\s>]/i.test(html) && !/<html[\s>]/i.test(html)) {
    warnings.push(
      "html has no <head> or <html> element; provide a complete HTML document (the injected runtime is prepended as a fallback).",
    );
  }
  return warnings;
}

function validateAppUiPermissions(
  permissions: AppUiPermissions | null,
): AppUiPermissions | null {
  if (permissions === null) return null;
  const parsed = AppUiPermissionsSchema.safeParse(permissions);
  if (!parsed.success) {
    const unknown = Object.keys(permissions).filter(
      (key) => !ALLOWED_PERMISSION_KEYS.includes(key as keyof AppUiPermissions),
    );
    throw new ApiError(
      400,
      unknown.length > 0
        ? `unknown app permission(s): ${unknown.join(", ")}`
        : "invalid app permissions shape",
    );
  }
  return parsed.data;
}
