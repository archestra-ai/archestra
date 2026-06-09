import type { AppTemplate } from "@/types";
import { blankTemplate } from "./blank";
import { formTemplate } from "./form";

// Curated starters surfaced by GET /api/app-templates and offered in the create
// dialog. `create_app` stores the chosen template's id as provenance only — the
// html is seeded client-side, never resolved server-side.
const APP_TEMPLATES: readonly AppTemplate[] = [blankTemplate, formTemplate];

export function getAppTemplates(): AppTemplate[] {
  return [...APP_TEMPLATES];
}
