import type { VersionPayload } from "@/models/app-version";
import { ApiError } from "@/types";
import {
  APP_HTML_MAX_BYTES,
  type AppUiCsp,
  type AppUiPermissions,
  AppUiPermissionsSchema,
} from "@/types/app";
import { loadAppRuntimeNative } from "./app-runtime-native";

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
 * hostnames only: the proxy HTML's client-side CSP builder (`buildCSP` in
 * static/mcp-sandbox-proxy.html) injects these into the guest meta-tag CSP.
 * A future feature may make this list org-configurable.
 */
export const APP_PLATFORM_CSP_RESOURCE_DOMAINS = [
  "cdn.jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
] as const;

export const APP_PLATFORM_CSP: AppUiCsp = {
  resourceDomains: [...APP_PLATFORM_CSP_RESOURCE_DOMAINS],
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
export async function buildValidatedVersionPayload(params: {
  html: string;
  uiPermissions?: AppUiPermissions | null;
}): Promise<{ payload: VersionPayload; warnings: string[] }> {
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
  // The HTML scan (SDK self-bootstrap, platform-asset self-loads, structural
  // warnings) runs in the app_runtime_core Rust crate; it returns a structured
  // rejection so the user-facing message stays here.
  const { scanAppHtml } = await loadAppRuntimeNative();
  const { rejection, warnings } = scanAppHtml(params.html);
  if (rejection) {
    throw new ApiError(400, rejectionMessage(rejection));
  }
  return {
    payload: {
      html: params.html,
      uiPermissions: validateAppUiPermissions(params.uiPermissions ?? null),
    },
    warnings,
  };
}

// Document-root probe, mirroring the Rust scanner's HEAD_OR_HTML
// (app_html.rs): true when the HTML opens a <head> or <html> element. Used to
// gate an edit that would strip a document root the base version still had — a
// fragment-from-the-start app (no root to begin with) is unaffected. Kept as the
// same raw-text regex as the scanner on purpose: its precision (it would also
// match a `<html>` written inside a comment or string) is exactly the platform's
// existing notion of "has a document root", so the edit gate and the save-time
// warning never disagree.
const HTML_DOCUMENT_ROOT_PATTERN = /<(head|html)[\s>]/i;

export function htmlHasDocumentRoot(html: string): boolean {
  return HTML_DOCUMENT_ROOT_PATTERN.test(html);
}

type AppValidationFinding = {
  severity: "error" | "warning";
  message: string;
};

/**
 * Static, headless validation of an app's stored HTML for the `validate_app`
 * MCP tool. Reuses the save-time Rust scan (SDK self-bootstrap, platform-asset
 * self-loads, missing document root) — surfaced here as findings rather than a
 * thrown rejection so authoring tools can report them — and adds the one check
 * the scanner does not do: `<script src>`/`<link href>` hosts outside
 * {@link APP_PLATFORM_CSP_RESOURCE_DOMAINS}, which the served CSP blocks at
 * render time, are flagged as warnings. It cannot exercise runtime behaviour;
 * that gap is what the live diagnostics round-trip covers.
 */
export async function validateAppHtmlStatic(
  html: string,
): Promise<AppValidationFinding[]> {
  const findings: AppValidationFinding[] = [];
  const { scanAppHtml } = await loadAppRuntimeNative();
  const { rejection, warnings } = scanAppHtml(html);
  if (rejection) {
    findings.push({ severity: "error", message: rejectionMessage(rejection) });
  }
  for (const warning of warnings) {
    findings.push({ severity: "warning", message: warning });
  }
  for (const host of offAllowlistResourceHosts(html)) {
    findings.push({
      severity: "warning",
      message: `<script>/<link> references the host "${host}", which is outside the app CDN allowlist (${APP_PLATFORM_CSP_RESOURCE_DOMAINS.join(
        ", ",
      )}); the sandbox CSP blocks it at render time. Load client-side assets from an allowlisted CDN, and fetch data through an assigned MCP tool instead.`,
    });
  }
  const browserStorageApis = browserStorageApisUsed(html);
  if (browserStorageApis.length > 0) {
    findings.push({
      severity: "warning",
      message: `Uses browser storage (${browserStorageApis.join(
        ", ",
      )}), which is unavailable in the app sandbox (an opaque origin where it throws) and ephemeral browser-local state even where it works. Persist state through the platform-attached store instead: archestra.storage.user.* (private per viewer) or archestra.storage.shared.* (shared across viewers).`,
    });
  }
  return findings;
}

const SCRIPT_BLOCK_PATTERN = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
const BROWSER_STORAGE_API_PATTERN =
  /\b(localStorage|sessionStorage|indexedDB)\b/g;

// Browser storage APIs referenced inside <script> blocks. Scoped to script
// content (not the whole html) so prose, comments, and attribute text that
// merely name an API do not warn — the same structural anchoring the resource
// check uses. It stays a lexical scan: dynamic access (window["local"+"Storage"])
// is not detected, which is acceptable for a soft authoring hint. They are
// unusable in the app sandbox: the opaque-origin iframe throws on access, and
// where it doesn't the data is ephemeral and browser-local rather than the
// platform-attached archestra.storage. Returned in first-seen order, deduplicated.
function browserStorageApisUsed(html: string): string[] {
  const apis = new Set<string>();
  for (const block of html.matchAll(SCRIPT_BLOCK_PATTERN)) {
    for (const match of block[1].matchAll(BROWSER_STORAGE_API_PATTERN)) {
      apis.add(match[1]);
    }
  }
  return [...apis];
}

const RESOURCE_REF_PATTERN =
  /<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi;

// External hosts referenced by <script src>/<link href> that are not on the CSP
// resource allowlist (exact host match, mirroring CSP host-source semantics).
function offAllowlistResourceHosts(html: string): string[] {
  const allowlist = new Set<string>(APP_PLATFORM_CSP_RESOURCE_DOMAINS);
  const hosts = new Set<string>();
  for (const match of html.matchAll(RESOURCE_REF_PATTERN)) {
    const host = externalHost(match[1]);
    if (host && !allowlist.has(host)) {
      hosts.add(host);
    }
  }
  return [...hosts];
}

// The host of an absolute or protocol-relative http(s) URL; null for relative,
// data:, blob:, or otherwise host-less refs (which the resource CSP ignores).
function externalHost(ref: string): string | null {
  const normalized = ref.startsWith("//") ? `https:${ref}` : ref;
  if (!/^https?:\/\//i.test(normalized)) return null;
  try {
    return new URL(normalized).hostname;
  } catch {
    return null;
  }
}

function rejectionMessage(rejection: {
  kind: string;
  offender: string;
}): string {
  switch (rejection.kind) {
    case "sdk_bootstrap":
      return `app html must not bootstrap the MCP App SDK itself (found "${rejection.offender}" in a <script>). The platform injects window.archestra (storage, tools, user identity, host features) at render time — remove the SDK import and transport wiring and use window.archestra directly.`;
    case "platform_script_src":
      return `app html must not load the platform SDK itself (found <script src="${rejection.offender}">). The platform injects window.archestra at render time — remove the script tag and use window.archestra directly.`;
    case "platform_base_css":
      return `app html must not load the platform stylesheet itself (found <link href="${rejection.offender}">). The platform injects archestra-app-base.css at render time — remove the link; its theme variables, element defaults, and .arch-* components are already available.`;
    default:
      return "app html could not be parsed as HTML.";
  }
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
