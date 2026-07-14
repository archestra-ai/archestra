import OrganizationModel from "@/models/organization";
import type { AppearanceSettings, AppTemplate } from "@/types";
import { APP_HTML_MAX_BYTES } from "@/types";
import { defaultTemplate, defaultTemplateLogoHtml } from "./default";

// The single opinionated starter surfaced by GET /api/app-templates and seeded
// by the create paths. Its id is stored on the app row as provenance.
const APP_TEMPLATES: readonly AppTemplate[] = [defaultTemplate];

/** Provenance recorded on an app row seeded from the default template. */
export const DEFAULT_APP_TEMPLATE_ID = defaultTemplate.id;

export async function getAppTemplates(): Promise<AppTemplate[]> {
  // Surface a presentable preview: resolve the name token to a neutral default
  // and the logo token to the effective branding, so no raw `{{APP_NAME}}` /
  // `{{APP_LOGO}}` leaks to GET /api/app-templates or the save-gate.
  const logoHtml = await resolveTemplateLogoHtml();
  return APP_TEMPLATES.map((t) => ({
    ...t,
    html: renderTemplateHtml(t.html, { name: "My App", logoHtml }),
  }));
}

/**
 * Resolve the initial HTML for a new app. Explicit `html` always wins
 * (`templateId` is then provenance only); otherwise the single default template
 * seeds the first version, with `name` substituted into its `{{APP_NAME}}`
 * token and the `{{APP_LOGO}}` token resolved to the organization's
 * white-label logo when one is configured (the Archestra mark otherwise).
 * Shared by REST `POST /api/apps` and the `scaffold_app` tool (which always
 * omits html). Update paths never re-template an existing app.
 */
export async function resolveCreateAppHtml(input: {
  html?: string;
  name?: string;
}): Promise<{
  html: string;
  seededFromTemplate: boolean;
}> {
  if (input.html !== undefined) {
    return { html: input.html, seededFromTemplate: false };
  }
  const name = input.name ?? "My App";
  const logoHtml = await resolveTemplateLogoHtml();
  return {
    html: renderTemplateHtml(defaultTemplate.html, { name, logoHtml }),
    seededFromTemplate: true,
  };
}

// Substitute the `{{APP_NAME}}` token with an HTML-escaped name — so names
// with special characters render as text and can't break the markup or
// validation — and the `{{APP_LOGO}}` token with the (already-safe) logo block.
// A configured logo can be up to 2 MB decoded, so its data URI may push the
// document past the app HTML limit. Rather than fail the create (or fall back
// to the Archestra mark on a white-labeled instance), render without a logo
// block.
function renderTemplateHtml(
  template: string,
  tokens: { name: string; logoHtml: string },
): string {
  const html = applyTemplateTokens(template, tokens);
  if (Buffer.byteLength(html, "utf8") <= APP_HTML_MAX_BYTES) return html;
  return applyTemplateTokens(template, { ...tokens, logoHtml: "" });
}

function applyTemplateTokens(
  html: string,
  tokens: { name: string; logoHtml: string },
): string {
  return html
    .replaceAll("{{APP_NAME}}", escapeHtml(tokens.name))
    .replaceAll("{{APP_LOGO}}", tokens.logoHtml);
}

// The `{{APP_LOGO}}` block: the organization's white-label logo when one is
// configured, else the default Archestra mark. Logos are validated data URIs
// (see the appearance-settings schemas), so they render inline under the app
// sandbox CSP (`img-src` always allows `data:`) with no network fetch.
async function resolveTemplateLogoHtml(): Promise<string> {
  const appearance = await OrganizationModel.getAppearanceSettings();
  const logo = resolveWhiteLabelLogo(appearance);
  if (!logo) return defaultTemplateLogoHtml;
  const label = appearance.appName ?? "Logo";
  // With a dark variant, both images are emitted and the template's
  // `prefers-color-scheme` rules toggle between them; otherwise the single
  // image serves both themes.
  const images = logo.dark
    ? `<img class="logo-light" src="${escapeHtml(logo.light)}" alt="" />
    <img class="logo-dark" src="${escapeHtml(logo.dark)}" alt="" />`
    : `<img src="${escapeHtml(logo.light)}" alt="" />`;
  return `<button type="button" class="logo" aria-label="${escapeHtml(label)}">
    ${images}
  </button>`;
}

// Pick the branding pair for the template's square-ish mark slot: the icon
// logos when any is set (they are square by design), the full logos otherwise.
// Variants never mix across pairs; a missing side falls back to the other so a
// single configured image serves both themes.
function resolveWhiteLabelLogo(
  appearance: AppearanceSettings,
): { light: string; dark: string | null } | null {
  const preferIcon = Boolean(appearance.iconLogo ?? appearance.iconLogoDark);
  const lightVariant = preferIcon ? appearance.iconLogo : appearance.logo;
  const darkVariant = preferIcon
    ? appearance.iconLogoDark
    : appearance.logoDark;
  const light = lightVariant ?? darkVariant;
  if (!light) return null;
  const dark =
    lightVariant && darkVariant !== lightVariant ? darkVariant : null;
  return { light, dark: dark ?? null };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
