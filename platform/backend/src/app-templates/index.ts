import type { AppTemplate } from "@/types";
import { defaultTemplate } from "./default";

// The single opinionated starter surfaced by GET /api/app-templates and seeded
// by the create paths. Its id is stored on the app row as provenance.
const APP_TEMPLATES: readonly AppTemplate[] = [defaultTemplate];

/** Provenance recorded on an app row seeded from the default template. */
export const DEFAULT_APP_TEMPLATE_ID = defaultTemplate.id;

export function getAppTemplates(): AppTemplate[] {
  return [...APP_TEMPLATES];
}

/**
 * Resolve the initial HTML for a new app. Explicit `html` always wins
 * (`templateId` is then provenance only); otherwise the single default template
 * seeds the first version. Shared by REST `POST /api/apps` and the `scaffold_app`
 * tool (which always omits html). Update paths never re-template an existing app.
 */
export function resolveCreateAppHtml(input: { html?: string }): {
  html: string;
  seededFromTemplate: boolean;
} {
  if (input.html !== undefined) {
    return { html: input.html, seededFromTemplate: false };
  }
  return { html: defaultTemplate.html, seededFromTemplate: true };
}
