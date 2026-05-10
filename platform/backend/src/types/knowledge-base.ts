import { z } from "zod";

/**
 * Object-level visibility for knowledge sources.
 */
export const KnowledgeSourceVisibilitySchema = z.enum([
  "org-wide",
  "team-scoped",
  "auto-sync-permissions",
]);
export type KnowledgeSourceVisibility = z.infer<
  typeof KnowledgeSourceVisibilitySchema
>;
