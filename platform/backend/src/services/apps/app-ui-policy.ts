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

/**
 * The `window.archestra` member surface the platform injects into a rendered app
 * (see `static/archestra-app-sdk.js`). Single source of truth for the SDK-usage
 * lint in {@link validateAppHtmlStatic}; the drift guard in
 * `app-sdk-injection.test.ts` cross-checks every member listed here against that
 * file, so the allowlist cannot silently fall out of sync with the real SDK.
 *
 * @public — the export is consumed only by the drift-guard test, invisible to
 * `knip --production`; the lint itself reads it in-module.
 */
export const ARCHESTRA_APP_SDK_SURFACE = {
  topLevel: ["ready", "user", "context", "storage", "llm", "tools", "ui"],
  storage: {
    partitions: ["user", "shared"],
    methods: ["get", "set", "list", "delete"],
  },
  tools: ["call", "list"],
  llm: ["complete", "prompt"],
  ui: ["openLink", "requestDisplayMode"],
} as const;

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
 * MCP tool: the save-time Rust scan (surfaced as findings rather than a thrown
 * rejection) plus the Rust-backed authoring lint — off-allowlist
 * `<script src>`/`<link href>` hosts, browser storage APIs the sandbox breaks,
 * and window.archestra members the injected SDK does not expose. This module
 * stays the single source of truth for the policy inputs and the warning text;
 * Rust returns structured lists. It cannot exercise runtime behaviour; that
 * gap is what the live diagnostics round-trip covers.
 */
export async function validateAppHtmlStatic(
  html: string,
): Promise<AppValidationFinding[]> {
  const findings: AppValidationFinding[] = [];
  const { scanAppHtml, lintAppHtml } = await loadAppRuntimeNative();
  const { rejection, warnings } = scanAppHtml(html);
  if (rejection) {
    findings.push({ severity: "error", message: rejectionMessage(rejection) });
  }
  for (const warning of warnings) {
    findings.push({ severity: "warning", message: warning });
  }
  const lint = lintAppHtml(html, {
    resourceHostAllowlist: [...APP_PLATFORM_CSP_RESOURCE_DOMAINS],
    sdkTopLevelMembers: [...ARCHESTRA_APP_SDK_SURFACE.topLevel],
    sdkStoragePartitions: [...ARCHESTRA_APP_SDK_SURFACE.storage.partitions],
  });
  for (const host of lint.offAllowlistHosts) {
    findings.push({
      severity: "warning",
      message: `<script>/<link> references the host "${host}", which is outside the app CDN allowlist (${APP_PLATFORM_CSP_RESOURCE_DOMAINS.join(
        ", ",
      )}); the sandbox CSP blocks it at render time. Load client-side assets from an allowlisted CDN, and fetch data through an assigned MCP tool instead.`,
    });
  }
  if (lint.browserStorageApis.length > 0) {
    findings.push({
      severity: "warning",
      message: `Uses browser storage (${lint.browserStorageApis.join(
        ", ",
      )}), which is unavailable in the app sandbox (an opaque origin where it throws) and ephemeral browser-local state even where it works. Persist state through the platform-attached store instead: archestra.storage.user.* (private per viewer) or archestra.storage.shared.* (shared across viewers).`,
    });
  }
  if (lint.storageMisuse.length > 0) {
    findings.push({
      severity: "warning",
      message: `Accesses ${lint.storageMisuse.join(
        ", ",
      )} directly, but the store has no such member — it is partitioned. Call it on a partition instead: archestra.storage.user.* (private per viewer) or archestra.storage.shared.* (shared across viewers), e.g. archestra.storage.user.get(key).`,
    });
  }
  if (lint.unknownTopLevel.length > 0) {
    findings.push({
      severity: "warning",
      message: `Uses ${lint.unknownTopLevel.join(
        ", ",
      )}, which the injected window.archestra SDK does not expose. Its top-level surface is ${ARCHESTRA_APP_SDK_SURFACE.topLevel
        .map((member) => `archestra.${member}`)
        .join(", ")}.`,
    });
  }
  return findings;
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
