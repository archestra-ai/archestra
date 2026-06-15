import { ApiError, type AppTemplate } from "@/types";
import { blankTemplate } from "./blank";
import { formTemplate } from "./form";

// Curated starters surfaced by GET /api/app-templates and offered in the create
// dialog. Create paths resolve `templateId` server-side via
// resolveCreateAppHtml; on an app row the id is stored as provenance.
const APP_TEMPLATES: readonly AppTemplate[] = [blankTemplate, formTemplate];

export function getAppTemplates(): AppTemplate[] {
  return [...APP_TEMPLATES];
}

/**
 * Resolve the initial HTML for a new app. Explicit `html` always wins
 * (`templateId` is then provenance only); otherwise the template seeds the
 * first version. Shared by REST `POST /api/apps` and the `create_app` tool.
 * Update paths never re-template an existing app.
 */
export function resolveCreateAppHtml(input: {
  html?: string;
  templateId?: string;
}): { html: string; seededFromTemplate: boolean } {
  if (input.html !== undefined) {
    return { html: input.html, seededFromTemplate: false };
  }
  if (input.templateId !== undefined) {
    const template = APP_TEMPLATES.find((t) => t.id === input.templateId);
    if (!template) {
      const known = APP_TEMPLATES.map((t) => t.id).join(", ");
      throw new ApiError(
        400,
        `Unknown templateId "${input.templateId}". Available templates: ${known}.`,
      );
    }
    return { html: template.html, seededFromTemplate: true };
  }
  throw new ApiError(400, "Either html or templateId is required.");
}
