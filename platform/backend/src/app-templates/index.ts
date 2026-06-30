import type { AppTemplate } from "@/types";
import { defaultTemplate } from "./default";

// The single opinionated starter surfaced by GET /api/app-templates and seeded
// by the create paths. Its id is stored on the app row as provenance.
const APP_TEMPLATES: readonly AppTemplate[] = [defaultTemplate];

/** Provenance recorded on an app row seeded from the default template. */
export const DEFAULT_APP_TEMPLATE_ID = defaultTemplate.id;

export function getAppTemplates(): AppTemplate[] {
  // Surface a presentable preview: resolve the name token to a neutral default
  // so no raw `{{APP_NAME}}` leaks to GET /api/app-templates or the save-gate.
  return APP_TEMPLATES.map((t) => ({
    ...t,
    html: applyAppName(t.html, "My App"),
  }));
}

/**
 * Resolve the initial HTML for a new app. Explicit `html` always wins
 * (`templateId` is then provenance only); otherwise the single default template
 * seeds the first version, with `name` substituted into its `{{APP_NAME}}`
 * token. Shared by REST `POST /api/apps` and the `scaffold_app` tool (which
 * always omits html). Update paths never re-template an existing app.
 */
export function resolveCreateAppHtml(input: { html?: string; name?: string }): {
  html: string;
  seededFromTemplate: boolean;
} {
  if (input.html !== undefined) {
    return { html: input.html, seededFromTemplate: false };
  }
  return {
    html: applyAppName(defaultTemplate.html, input.name ?? "My App"),
    seededFromTemplate: true,
  };
}

// Substitute the `{{APP_NAME}}` token with an HTML-escaped name so names with
// special characters render as text and can't break the markup or validation.
function applyAppName(html: string, name: string): string {
  return html.replaceAll("{{APP_NAME}}", escapeHtml(name));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
