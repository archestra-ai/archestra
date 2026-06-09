import type { VersionPayload } from "@/models/app-version";
import { ApiError } from "@/types";
import {
  type AppUiCsp,
  AppUiCspSchema,
  type AppUiPermissions,
  AppUiPermissionsSchema,
} from "@/types/app";
import { isCspHostname } from "@/utils/csp-domain";

/**
 * Save-time security policy for an app's UI envelope (CSP + iframe permissions).
 *
 * This is the strict, reject-on-save gate — distinct from the serve-time
 * `sanitizeCspDomains` filter in `server.ts`, which silently drops invalid
 * entries as a defence-in-depth net. Here an author who writes a malformed
 * domain gets a clear error and the stored CSP is exactly what they intended
 * (no silent drops). It is deliberately a single self-contained module so the
 * same rules can move to the Rust/NAPI layer later if needed.
 *
 * A null envelope is the restrictive default: `buildCspHeader(undefined)`
 * resolves to `default-src 'none'`, `connect-src 'self'`, `frame-src 'none'`,
 * etc., so an app that declares nothing can talk only to its own origin.
 *
 * Domains are validated with the shared `isCspHostname` (a bare host, no scheme
 * or port) so anything accepted here survives the serve-time `sanitizeCspDomains`
 * filter (same host grammar) instead of being silently dropped.
 */

const CSP_DOMAIN_FIELDS = [
  "connectDomains",
  "resourceDomains",
  "frameDomains",
  "baseUriDomains",
] as const satisfies readonly (keyof AppUiCsp)[];

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
 * Validate an app's CSP + permissions and assemble the version payload to
 * persist. Throws `ApiError(400)` on any malformed domain or unknown permission
 * key. Absent CSP/permissions normalize to `null` (the restrictive default).
 */
export function buildValidatedVersionPayload(params: {
  html: string;
  uiCsp?: AppUiCsp | null;
  uiPermissions?: AppUiPermissions | null;
}): VersionPayload {
  return {
    html: params.html,
    uiCsp: validateAppUiCsp(params.uiCsp ?? null),
    uiPermissions: validateAppUiPermissions(params.uiPermissions ?? null),
  };
}

function validateAppUiCsp(csp: AppUiCsp | null): AppUiCsp | null {
  if (csp === null) return null;
  // Re-parse so an unknown top-level key is rejected even if the caller bypassed
  // the route/tool schema (defence in depth at the single save chokepoint).
  const parsed = AppUiCspSchema.safeParse(csp);
  if (!parsed.success) {
    throw new ApiError(400, "invalid app CSP shape");
  }

  for (const field of CSP_DOMAIN_FIELDS) {
    for (const domain of parsed.data[field] ?? []) {
      if (!isCspHostname(domain)) {
        throw new ApiError(
          400,
          `invalid CSP domain in ${field}: "${domain}" (expected a bare hostname like example.com or *.example.com, no scheme or port)`,
        );
      }
    }
  }
  return parsed.data;
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
